import { sql } from '@vercel/postgres';
import { verifyAuth, setCORSHeaders } from './auth-helper.js';

let pusher = null;
try {
  if (process.env.PUSHER_APP_ID) {
    const Pusher = (await import('pusher')).default;
    pusher = new Pusher({
      appId: process.env.PUSHER_APP_ID, key: process.env.PUSHER_KEY,
      secret: process.env.PUSHER_SECRET, cluster: process.env.PUSHER_CLUSTER, useTLS: true,
    });
  }
} catch (e) { console.warn('[chat] Pusher not available:', e.message); }

export default async function handler(req, res) {
  setCORSHeaders(res);
  if (req.method === 'OPTIONS') return res.status(204).end();

  await sql`
    CREATE TABLE IF NOT EXISTS chat_messages (
      id SERIAL PRIMARY KEY, username TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'web', content TEXT NOT NULL,
      avatar_url TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;

  if (req.method === 'GET') {
    const user = await verifyAuth(req, res);
    if (!user) return;
    const { rows } = await sql`
      SELECT id, username, source, content, avatar_url, created_at
      FROM chat_messages ORDER BY created_at DESC LIMIT 50
    `;
    return res.status(200).json({ messages: rows.reverse() });
  }

  if (req.method === 'POST') {
    const bridgeSecret = req.headers['x-bridge-secret'];
    let username, source, avatar_url;

    if (bridgeSecret && bridgeSecret === process.env.BRIDGE_SECRET) {
      username = req.body?.username; source = req.body?.source ?? 'discord'; avatar_url = req.body?.avatar_url ?? null;
    } else {
      const user = await verifyAuth(req, res);
      if (!user) return;
      username = user.mc_username ?? user.discord_username;
      source = 'web'; avatar_url = user.avatar_url ?? user.discord_avatar ?? null;
    }

    const content = req.body?.content?.trim();
    if (!content) return res.status(400).json({ error: 'Message content is required.' });
    if (content.length > 500) return res.status(400).json({ error: 'Max 500 characters.' });

    const { rows } = await sql`
      INSERT INTO chat_messages (username, source, content, avatar_url)
      VALUES (${username}, ${source}, ${content}, ${avatar_url})
      RETURNING id, username, source, content, avatar_url, created_at
    `;
    const msg = rows[0];
    if (pusher) await pusher.trigger('smp-chat', 'new-message', msg).catch(e => console.warn('[chat] pusher:', e.message));
    return res.status(201).json({ message: msg });
  }

  return res.status(405).json({ error: 'Method Not Allowed' });
}