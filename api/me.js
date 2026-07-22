import { sql } from '@vercel/postgres';
import jwt from 'jsonwebtoken';

const ALLOWED_ORIGIN = 'https://cloudrend.vercel.app';

export default async function handler(req, res) {
  // ── Restrict CORS to own domain only ──
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Vary', 'Origin');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method Not Allowed' });

  const authHeader = req.headers['authorization'];
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or malformed Authorization header.' });
  }

  // ── Verify JWT ──
  let payload;
  try {
    payload = jwt.verify(authHeader.slice(7).trim(), process.env.JWT_SECRET);
  } catch (err) {
    return res.status(401).json({
      error: err.name === 'TokenExpiredError'
        ? 'Session expired. Please log in again.'
        : 'Invalid session token.',
    });
  }

  // ── Re-validate against DB ──
  try {
    const { rows, rowCount } = await sql`
      SELECT id, discord_id, discord_username, discord_avatar,
             mc_username, status, ban_reason, role, avatar_url, bio
      FROM users
      WHERE id = ${payload.id} AND discord_id = ${payload.discord_id}
      LIMIT 1
    `;

    if (rowCount === 0) {
      return res.status(401).json({ error: 'Session invalid. User not found.' });
    }

    const user = rows[0];

    // ── FIX B: Actively block banned users — do not just return status ──
    if (user.status === 'banned') {
      return res.status(403).json({
        error: 'You are banned from Cloudrend SMP.',
        banned: true,
        ban_reason: user.ban_reason ?? 'No reason provided.',
      });
    }

    return res.status(200).json({
      id:             user.id,
      discord_id:     user.discord_id,
      username:       user.discord_username,
      discord_avatar: user.discord_avatar,
      mc_username:    user.mc_username ?? null,
      status:         user.status,
      ban_reason:     user.ban_reason ?? null,
      role:           user.role ?? 'member',
      avatar_url:     user.avatar_url ?? null,
      bio:            user.bio ?? null,
    });
  } catch (err) {
    console.error('[me] DB error:', err);
    return res.status(500).json({ error: 'Internal server error.' });
  }
}
