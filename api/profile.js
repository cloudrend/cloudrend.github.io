import { sql } from '@vercel/postgres';
import { verifyAuth, setCORSHeaders } from './auth-helper.js';

export default async function handler(req, res) {
  setCORSHeaders(res);
  if (req.method === 'OPTIONS') return res.status(204).end();

  const payload = await verifyAuth(req, res);
  if (!payload) return;

  if (req.method === 'GET') {
    const { username } = req.query;
    const target = username ?? payload.discord_username;
    const { rows, rowCount } = await sql`
      SELECT discord_username, mc_username, role, discord_avatar, avatar_url, bio, status
      FROM users WHERE LOWER(discord_username)=LOWER(${target}) OR LOWER(mc_username)=LOWER(${target}) LIMIT 1
    `;
    if (rowCount === 0) return res.status(404).json({ error: 'User not found.' });
    return res.status(200).json(rows[0]);
  }

  if (req.method === 'PATCH') {
    const { avatar_url, bio } = req.body ?? {};
    if (avatar_url !== undefined) {
      try { new URL(avatar_url); } catch { return res.status(400).json({ error: 'Invalid URL.' }); }
      if (!avatar_url.startsWith('http://') && !avatar_url.startsWith('https://'))
        return res.status(400).json({ error: 'URL must start with http(s)://' });
    }
    if (bio !== undefined && bio.length > 100) return res.status(400).json({ error: 'Bio max 100 chars.' });

    await sql`UPDATE users SET avatar_url=COALESCE(${avatar_url??null},avatar_url), bio=COALESCE(${bio??null},bio) WHERE id=${payload.id}`;
    const { rows } = await sql`SELECT discord_username, mc_username, role, discord_avatar, avatar_url, bio FROM users WHERE id=${payload.id}`;
    return res.status(200).json({ message: 'Profile updated.', user: rows[0] });
  }

  return res.status(405).json({ error: 'Method Not Allowed' });
}