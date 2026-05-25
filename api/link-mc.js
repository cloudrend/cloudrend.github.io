import { sql } from '@vercel/postgres';
import jwt from 'jsonwebtoken';
import { verifyAuth, setCORSHeaders } from './auth-helper.js';

export default async function handler(req, res) {
  setCORSHeaders(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  const user = await verifyAuth(req, res);
  if (!user) return;

  const { mc_username } = req.body ?? {};
  if (!mc_username?.trim()) return res.status(400).json({ error: 'Minecraft username is required.' });
  if (!/^[a-zA-Z0-9_]{3,16}$/.test(mc_username.trim()))
    return res.status(400).json({ error: 'Invalid Minecraft username. 3–16 chars, letters/numbers/underscores only.' });

  const existing = await sql`
    SELECT id FROM users WHERE LOWER(mc_username)=LOWER(${mc_username.trim()}) AND id != ${user.id} LIMIT 1
  `;
  if (existing.rowCount > 0)
    return res.status(409).json({ error: 'That Minecraft username is already linked to another account.' });

  const { rows } = await sql`
    UPDATE users SET mc_username=${mc_username.trim()} WHERE id=${user.id}
    RETURNING id, discord_id, discord_username, discord_avatar, mc_username, status, role, avatar_url, bio
  `;
  const updated = rows[0];

  const token = jwt.sign(
    { id: updated.id, discord_id: updated.discord_id, username: updated.discord_username, role: updated.role },
    process.env.JWT_SECRET,
    { expiresIn: '7d' }
  );

  return res.status(200).json({ message: 'Minecraft account linked!', token, user: updated });
}