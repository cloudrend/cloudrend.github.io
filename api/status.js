// /api/status.js
// Vercel Serverless Function — reports whether CloudrendSMP is online,
// how many players are connected, and whether it's in maintenance mode.
//
// GET  /api/status
//   -> { online, playerCount, maxPlayers, motd, players, maintenance,
//        maintenanceMessage, updatedAt }
//
// POST /api/status   (any subset of these fields; only what you send gets updated)
//   { "players": ["Steve","Alex"] }
//   { "maintenance": true, "maintenanceMessage": "Upgrading to 1.21.5, back in 30 min" }
//   { "maintenance": false }
//   header: Authorization: Bearer <UPDATE_SECRET>
//
// Player COUNT works out of the box via a public ping API (mcsrvstat.us).
// Player NAMES and MAINTENANCE STATE only show up once your server starts
// POSTing them here — see SETUP.md for the Skript + SkBee script that does
// this. For maintenance mode specifically, tie the POST into whatever
// toggles your "Maintenance" plugin on/off (a command block, a Skript
// command hook, etc.) so the banner flips automatically.

import { neon } from '@neondatabase/serverless';

const BEDROCK_ADDRESS = '15.235.159.75:25681';
const sql = neon(process.env.DATABASE_URL);

async function pingServer() {
  try {
    const res = await fetch(`https://api.mcsrvstat.us/bedrock/3/${BEDROCK_ADDRESS}`, {
      headers: { 'User-Agent': 'CloudrendSMP-status-page' }
    });
    if (!res.ok) return { online: false };
    const data = await res.json();
    return {
      online: !!data.online,
      playerCount: data.players ? data.players.online : null,
      maxPlayers: data.players ? data.players.max : null,
      motd: data.motd && data.motd.clean ? data.motd.clean.join(' ') : null
    };
  } catch (err) {
    return { online: false };
  }
}

async function getLatestRow() {
  try {
    const rows = await sql`
      SELECT players, maintenance, maintenance_message
      FROM server_status ORDER BY id DESC LIMIT 1
    `;
    return rows[0] || null;
  } catch (err) {
    return null; // table may not exist yet
  }
}

export default async function handler(req, res) {
  if (req.method === 'GET') {
    const ping = await pingServer();
    const latest = await getLatestRow();

    res.setHeader('Cache-Control', 's-maxage=15, stale-while-revalidate=30');
    return res.status(200).json({
      online: ping.online,
      playerCount: ping.playerCount,
      maxPlayers: ping.maxPlayers,
      motd: ping.motd,
      players: latest ? latest.players : [],
      maintenance: latest ? !!latest.maintenance : false,
      maintenanceMessage: latest ? latest.maintenance_message : null,
      updatedAt: new Date().toISOString()
    });
  }

  if (req.method === 'POST') {
    const auth = req.headers.authorization;
    if (auth !== `Bearer ${process.env.UPDATE_SECRET}`) {
      return res.status(401).json({ error: 'unauthorized' });
    }

    const body = req.body || {};
    const latest = await getLatestRow();

    const playersProvided = Array.isArray(body.players);
    const maintenanceProvided = typeof body.maintenance === 'boolean';

    const mergedPlayers = playersProvided ? body.players : (latest ? latest.players : []);
    const mergedMaintenance = maintenanceProvided ? body.maintenance : (latest ? !!latest.maintenance : false);
    const mergedMessage = maintenanceProvided
      ? (body.maintenanceMessage || null)
      : (latest ? latest.maintenance_message : null);

    try {
      await sql`
        INSERT INTO server_status (players, maintenance, maintenance_message, updated_at)
        VALUES (${JSON.stringify(mergedPlayers)}, ${mergedMaintenance}, ${mergedMessage}, now())
      `;
      return res.status(200).json({
        ok: true,
        players: mergedPlayers.length,
        maintenance: mergedMaintenance
      });
    } catch (err) {
      return res.status(500).json({ error: 'database error', detail: String(err) });
    }
  }

  res.setHeader('Allow', 'GET, POST');
  return res.status(405).json({ error: 'method not allowed' });
}
