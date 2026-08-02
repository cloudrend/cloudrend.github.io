// /api/leaderboards.js
// Vercel Serverless Function — stores/serves the ELO and Playtime
// leaderboards using Vercel KV (a small hosted key-value store).
//
// GET  /api/leaderboards?type=elo        -> returns the stored array
// GET  /api/leaderboards?type=playtime   -> returns the stored array
// POST /api/leaderboards?type=elo        -> overwrites the stored array
//      body: [ { "name": "Basalttide", "value": 2184 }, ... ]
//      header: Authorization: Bearer <UPDATE_SECRET>
//
// Setup (one-time, in the Vercel dashboard):
//   1. Project -> Storage -> Create Database -> KV. Connect it to this
//      project. Vercel auto-adds the KV_REST_API_URL / KV_REST_API_TOKEN
//      environment variables for you.
//   2. Project -> Settings -> Environment Variables -> add UPDATE_SECRET
//      (any long random string you make up). This is the password your
//      Minecraft server uses to push new standings in.
//   3. In this project's terminal: npm install @vercel/kv
//   4. Deploy. That's it — no separate server needed.

import { kv } from '@vercel/kv';

const ALLOWED_TYPES = ['elo', 'playtime'];

export default async function handler(req, res) {
  const type = req.query.type;

  if (!ALLOWED_TYPES.includes(type)) {
    return res.status(400).json({ error: 'type must be "elo" or "playtime"' });
  }

  const key = `leaderboard:${type}`;

  if (req.method === 'GET') {
    const data = (await kv.get(key)) || [];
    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=120');
    return res.status(200).json(data);
  }

  if (req.method === 'POST') {
    const auth = req.headers.authorization;
    if (auth !== `Bearer ${process.env.UPDATE_SECRET}`) {
      return res.status(401).json({ error: 'unauthorized' });
    }

    const body = req.body;
    if (!Array.isArray(body)) {
      return res.status(400).json({ error: 'body must be an array of { name, value }' });
    }

    const sorted = [...body].sort((a, b) => b.value - a.value);
    await kv.set(key, sorted);
    return res.status(200).json({ ok: true, count: sorted.length });
  }

  res.setHeader('Allow', 'GET, POST');
  return res.status(405).json({ error: 'method not allowed' });
}
