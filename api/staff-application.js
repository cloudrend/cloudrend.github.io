import { sql } from '@vercel/postgres';
import { verifyAuth, setCORSHeaders } from './auth-helper.js';
import { notifyDiscordChannel, buildStaffApplicationEmbed, STAFF_APP_CHANNEL_ID } from './discord-notify.js';

// ─────────────────────────────────────────────
// Table: staff_applications
// Separate table from `users` — these are raw
// application submissions, not accounts.
// ─────────────────────────────────────────────
async function ensureTable() {
  await sql`
    CREATE TABLE IF NOT EXISTS staff_applications (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

      -- Identity
      identity_method   text NOT NULL CHECK (identity_method IN ('discord_oauth', 'manual_entry')),
      discord_username  text NOT NULL,
      discord_id        text,              -- only present for discord_oauth submissions
      ign               text NOT NULL,

      -- Section 1
      age               int  NOT NULL,
      timezone          text NOT NULL,
      hours_per_week    text NOT NULL,
      has_mic           text NOT NULL,

      -- Section 2
      prior_experience  text NOT NULL,
      unique_fit        text NOT NULL,

      -- Section 3
      scenario_a        text NOT NULL,
      scenario_b        text NOT NULL,
      scenario_c        text NOT NULL,
      scenario_d        text NOT NULL,

      -- Section 4
      honor_pledge      text NOT NULL,

      -- Review state
      status            text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','rejected')),
      reviewed_by        text,
      reviewed_at        timestamptz,
      review_note        text,

      submitted_at      timestamptz NOT NULL DEFAULT now()
    )
  `;
}

const HONOR_PHRASE = "I certify that all answers in this application were written entirely by me, without the use of ChatGPT or any other AI writing assistants.";

const REQUIRED_FIELDS = [
  'identity_method', 'discord_username', 'ign', 'age', 'timezone',
  'hours_per_week', 'has_mic', 'prior_experience', 'unique_fit',
  'scenario_a', 'scenario_b', 'scenario_c', 'scenario_d', 'honor_pledge',
];

export default async function handler(req, res) {
  setCORSHeaders(res);
  if (req.method === 'OPTIONS') return res.status(204).end();

  await ensureTable();

  const { action } = req.query;

  // ─────────────────────────────────────────
  // POST /api/staff-application  — public submit, no auth required
  // (Applicants aren't logged in as staff — anyone can apply.
  //  If identity_method is discord_oauth, the frontend already
  //  verified the Discord session before calling this.)
  // ─────────────────────────────────────────
  if (req.method === 'POST' && !action) {
    const body = req.body ?? {};

    for (const field of REQUIRED_FIELDS) {
      if (body[field] === undefined || body[field] === null || String(body[field]).trim() === '') {
        return res.status(400).json({ error: `Missing required field: ${field}` });
      }
    }

    if (!['discord_oauth', 'manual_entry'].includes(body.identity_method)) {
      return res.status(400).json({ error: 'Invalid identity_method.' });
    }

    if (body.honor_pledge.trim() !== HONOR_PHRASE) {
      return res.status(400).json({ error: 'Honor pledge does not match required phrase exactly.' });
    }

    const age = Number(body.age);
    if (!Number.isFinite(age) || age < 15) {
      return res.status(400).json({ error: 'Applicants must be 15 or older.' });
    }

    // Basic spam guard: block duplicate pending applications from the same Discord username
    const { rowCount: dupeCount } = await sql`
      SELECT id FROM staff_applications
      WHERE LOWER(discord_username) = LOWER(${body.discord_username})
        AND status = 'pending'
      LIMIT 1
    `;
    if (dupeCount > 0) {
      return res.status(409).json({ error: 'You already have a pending application. Please wait for a review before applying again.' });
    }

    const { rows } = await sql`
      INSERT INTO staff_applications (
        identity_method, discord_username, discord_id, ign,
        age, timezone, hours_per_week, has_mic,
        prior_experience, unique_fit,
        scenario_a, scenario_b, scenario_c, scenario_d,
        honor_pledge
      ) VALUES (
        ${body.identity_method}, ${body.discord_username}, ${body.discord_id || null}, ${body.ign},
        ${age}, ${body.timezone}, ${body.hours_per_week}, ${body.has_mic},
        ${body.prior_experience}, ${body.unique_fit},
        ${body.scenario_a}, ${body.scenario_b}, ${body.scenario_c}, ${body.scenario_d},
        ${body.honor_pledge}
      )
      RETURNING id, submitted_at
    `;

    // Fire-and-forget Discord notification — never blocks or fails the applicant's submission
    notifyDiscordChannel(STAFF_APP_CHANNEL_ID, buildStaffApplicationEmbed({
      id: rows[0].id,
      ign: body.ign,
      discord_username: body.discord_username,
      identity_method: body.identity_method,
      age,
      timezone: body.timezone,
      hours_per_week: body.hours_per_week,
    })).catch(err => console.error('[staff-application] Discord notify failed:', err));

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

  // GET /api/staff-application?action=list — staff logs view
  if (req.method === 'GET' && action === 'list') {
    const { status } = req.query;
    const rows = status
      ? (await sql`
          SELECT * FROM staff_applications
          WHERE status = ${status}
          ORDER BY submitted_at DESC
        `).rows
      : (await sql`
          SELECT * FROM staff_applications
          ORDER BY submitted_at DESC
        `).rows;

    const { rows: counts } = await sql`
      SELECT status, COUNT(*)::int AS count FROM staff_applications GROUP BY status
    `;
    const summary = { pending: 0, accepted: 0, rejected: 0 };
    for (const c of counts) summary[c.status] = c.count;

    return res.status(200).json({ applications: rows, summary });
  }

  // POST /api/staff-application?action=review — accept/reject
  if (req.method === 'POST' && action === 'review') {
    const { id, decision, note } = req.body ?? {};
    if (!id || !['accepted', 'rejected'].includes(decision)) {
      return res.status(400).json({ error: 'id and decision (accepted/rejected) required.' });
    }

    const { rowCount } = await sql`
      UPDATE staff_applications
      SET status = ${decision}, reviewed_by = ${staff.discord_username}, reviewed_at = now(), review_note = ${note || null}
      WHERE id = ${id} AND status = 'pending'
    `;
    if (rowCount === 0) return res.status(404).json({ error: 'Application not found or already reviewed.' });

    return res.status(200).json({ message: `Application ${decision}.` });
  }

  return res.status(400).json({ error: `Unknown action: ${action ?? '(none)'}` });
}
