// /api/leaderboards.js
// Vercel Serverless Function — stores/serves the ELO and Playtime
// leaderboards using your Neon Postgres database.
//
// GET  /api/leaderboards?type=elo        -> returns the stored array
// GET  /api/leaderboards?type=playtime   -> returns the stored array
// POST /api/leaderboards?type=elo        -> overwrites the stored array
//      body: [ { "name": "Basalttide", "value": 2184 }, ... ]
//      header: Authorization: Bearer <UPDATE_SECRET>
//
// Setup (one-time):
//   1. In Neon, run the SQL in schema.sql (creates the leaderboards table).
//   2. In Vercel: Project -> Settings -> Environment Variables -> add
//      DATABASE_URL = your Neon connection string (the "pooled connection"
//      one from the Neon dashboard).
//   3. Also add UPDATE_SECRET = any long random string you make up. This
//      is the password your Minecraft server uses to push new standings in.
//   4. npm install (installs @neondatabase/serverless), then deploy.

import { neon } from '@neondatabase/serverless';

const ALLOWED_TYPES = ['elo', 'playtime'];
const sql = neon(process.env.DATABASE_URL);

export default async function handler(req, res) {
  const type = req.query.type;

  if (!ALLOWED_TYPES.includes(type)) {
    return res.status(400).json({ error: 'type must be "elo" or "playtime"' });
  }

  if (req.method === 'GET') {
    try {
      const rows = await sql`
        SELECT name, value FROM leaderboards
        WHERE type = ${type}
        ORDER BY value DESC
      `;
      res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=120');
      return res.status(200).json(rows);
    } catch (err) {
      return res.status(500).json({ error: 'database error', detail: String(err) });
    }
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

    try {
      await sql`DELETE FROM leaderboards WHERE type = ${type}`;
      for (const row of body) {
        await sql`
          INSERT INTO leaderboards (type, name, value)
          VALUES (${type}, ${row.name}, ${row.value})
        `;
      }
      return res.status(200).json({ ok: true, count: body.length });
    } catch (err) {
      return res.status(500).json({ error: 'database error', detail: String(err) });
    }
  }

  res.setHeader('Allow', 'GET, POST');
  return res.status(405).json({ error: 'method not allowed' });
}