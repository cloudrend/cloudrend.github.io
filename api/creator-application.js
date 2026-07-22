import { sql } from '@vercel/postgres';
import { verifyAuth, setCORSHeaders } from './auth-helper.js';
import { notifyDiscordChannel, buildCreatorApplicationEmbed, STAFF_APP_CHANNEL_ID } from './discord-notify.js';

// ─────────────────────────────────────────────
// Table: creator_applications
// Separate table — social_links stored as JSONB array:
// [{ platform, url, followers }, ...]
// ─────────────────────────────────────────────
async function ensureTable() {
  await sql`
    CREATE TABLE IF NOT EXISTS creator_applications (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

      -- Discord OAuth (always verified — this form requires login)
      discord_username  text NOT NULL,
      discord_id        text NOT NULL,
      ign               text NOT NULL,

      -- Section 2
      social_links      jsonb NOT NULL DEFAULT '[]',

      -- Section 3
      avg_views         text NOT NULL,
      content_type      text NOT NULL,
      upload_frequency  text NOT NULL,
      niche_pitch       text NOT NULL,

      -- Section 4
      ownership_proof   text NOT NULL,
      honor_pledge      text NOT NULL,

      -- Review state
      status            text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','rejected')),
      reviewed_by       text,
      reviewed_at       timestamptz,
      review_note       text,

      submitted_at      timestamptz NOT NULL DEFAULT now()
    )
  `;
}

const HONOR_PHRASE = "I certify that this application was filled out by me, and all linked channels belong directly to me.";
const VALID_PLATFORMS = ['YouTube', 'Twitch', 'TikTok', 'Kick', 'Instagram / Shorts'];
const VALID_CONTENT_TYPES = ["Let's Play Series", 'Live Streaming', 'Shorts & TikToks', 'Lore & Storytelling', 'Other'];
const VALID_FREQUENCIES = ['Daily', '2-3 times a week', 'Weekly', 'Bi-weekly'];

const REQUIRED_FIELDS = [
  'ign', 'avg_views', 'content_type', 'upload_frequency',
  'niche_pitch', 'ownership_proof', 'honor_pledge',
];

export default async function handler(req, res) {
  setCORSHeaders(res);
  if (req.method === 'OPTIONS') return res.status(204).end();

  await ensureTable();

  const { action } = req.query;

  // ─────────────────────────────────────────
  // POST /api/creator-application — requires Discord login
  // (This form is gated behind OAuth only — no manual-entry mode,
  //  since creator identity must be tied to a real Discord account.)
  // ─────────────────────────────────────────
  if (req.method === 'POST' && !action) {
    const user = await verifyAuth(req, res);
    if (!user) return; // verifyAuth already sent the error response

    const body = req.body ?? {};

    for (const field of REQUIRED_FIELDS) {
      if (body[field] === undefined || body[field] === null || String(body[field]).trim() === '') {
        return res.status(400).json({ error: `Missing required field: ${field}` });
      }
    }

    if (!VALID_CONTENT_TYPES.includes(body.content_type)) {
      return res.status(400).json({ error: 'Invalid content_type.' });
    }
    if (!VALID_FREQUENCIES.includes(body.upload_frequency)) {
      return res.status(400).json({ error: 'Invalid upload_frequency.' });
    }
    if (body.honor_pledge.trim() !== HONOR_PHRASE) {
      return res.status(400).json({ error: 'Honor pledge does not match required phrase exactly.' });
    }

    // Validate social links array
    let socialLinks = body.social_links;
    if (!Array.isArray(socialLinks)) socialLinks = [];
    if (socialLinks.length === 0) {
      return res.status(400).json({ error: 'Please add at least one social media link.' });
    }
    for (const link of socialLinks) {
      if (!VALID_PLATFORMS.includes(link.platform)) {
        return res.status(400).json({ error: `Invalid platform: ${link.platform}` });
      }
      if (!link.url || typeof link.url !== 'string' || !link.url.trim()) {
        return res.status(400).json({ error: 'Every social link needs a URL.' });
      }
      try { new URL(link.url); } catch {
        return res.status(400).json({ error: `Invalid URL: ${link.url}` });
      }
    }

    // Basic spam guard: block duplicate pending applications from the same Discord account
    const { rowCount: dupeCount } = await sql`
      SELECT id FROM creator_applications
      WHERE discord_id = ${user.discord_id}
        AND status = 'pending'
      LIMIT 1
    `;
    if (dupeCount > 0) {
      return res.status(409).json({ error: 'You already have a pending application. Please wait for a review before applying again.' });
    }

    const { rows } = await sql`
      INSERT INTO creator_applications (
        discord_username, discord_id, ign,
        social_links,
        avg_views, content_type, upload_frequency, niche_pitch,
        ownership_proof, honor_pledge
      ) VALUES (
        ${user.discord_username}, ${user.discord_id}, ${body.ign},
        ${JSON.stringify(socialLinks)}::jsonb,
        ${body.avg_views}, ${body.content_type}, ${body.upload_frequency}, ${body.niche_pitch},
        ${body.ownership_proof}, ${body.honor_pledge}
      )
      RETURNING id, submitted_at
    `;

    // Fire-and-forget Discord notification — never blocks or fails the applicant's submission
    notifyDiscordChannel(STAFF_APP_CHANNEL_ID, buildCreatorApplicationEmbed({
      id: rows[0].id,
      ign: body.ign,
      discord_username: user.discord_username,
      content_type: body.content_type,
      upload_frequency: body.upload_frequency,
      avg_views: body.avg_views,
      social_links: socialLinks,
    })).catch(err => console.error('[creator-application] Discord notify failed:', err));

    return res.status(201).json({
      message: 'Application submitted.',
      id: rows[0].id,
      submitted_at: rows[0].submitted_at,
    });
  }

  // ─────────────────────────────────────────
  // Everything below requires staff auth
  // ─────────────────────────────────────────
  const staff = await verifyAuth(req, res, { requireStaff: true });
  if (!staff) return;

  // GET /api/creator-application?action=list — staff logs view
  if (req.method === 'GET' && action === 'list') {
    const { status } = req.query;
    const rows = status
      ? (await sql`
          SELECT * FROM creator_applications
          WHERE status = ${status}
          ORDER BY submitted_at DESC
        `).rows
      : (await sql`
          SELECT * FROM creator_applications
          ORDER BY submitted_at DESC
        `).rows;

    const { rows: counts } = await sql`
      SELECT status, COUNT(*)::int AS count FROM creator_applications GROUP BY status
    `;
    const summary = { pending: 0, accepted: 0, rejected: 0 };
    for (const c of counts) summary[c.status] = c.count;

    return res.status(200).json({ applications: rows, summary });
  }

  // POST /api/creator-application?action=review — accept/reject
  if (req.method === 'POST' && action === 'review') {
    const { id, decision, note } = req.body ?? {};
    if (!id || !['accepted', 'rejected'].includes(decision)) {
      return res.status(400).json({ error: 'id and decision (accepted/rejected) required.' });
    }

    const { rowCount } = await sql`
      UPDATE creator_applications
      SET status = ${decision}, reviewed_by = ${staff.discord_username}, reviewed_at = now(), review_note = ${note || null}
      WHERE id = ${id} AND status = 'pending'
    `;
    if (rowCount === 0) return res.status(404).json({ error: 'Application not found or already reviewed.' });

    return res.status(200).json({ message: `Application ${decision}.` });
  }

  return res.status(400).json({ error: `Unknown action: ${action ?? '(none)'}` });
}
