// /api/status.js
// Vercel Serverless Function — reports whether CloudrendSMP is online,
// how many players are connected (Java + Bedrock combined), and whether
// it's in maintenance mode. Uses the mcsrvstat.us API for live pings.
//
// GET  /api/status
//   -> { online, playerCount, maxPlayers, motd, players, java, bedrock,
//        maintenance, maintenanceMessage, updatedAt }
//
// POST /api/status   (any subset of these fields; only what you send gets updated)
//   { "players": ["Steve","Alex"] }
//   { "maintenance": true, "maintenanceMessage": "Upgrading to 1.21.5, back in 30 min" }
//   { "maintenance": false }
//   header: Authorization: Bearer <UPDATE_SECRET>
//
// Player COUNT and, on Java, the real player NAME LIST work out of the box
// via mcsrvstat.us — no plugin needed, as long as your server doesn't hide
// its player sample. Bedrock's ping protocol only ever returns a count,
// never names. If Java also comes back without names (some server configs
// hide the sample), the site falls back to whatever's been POSTed here —
// see SETUP.md for the Skript + SkBee push script that does that.
// Maintenance mode always requires a POST either way.

import { neon } from '@neondatabase/serverless';

const JAVA_ADDRESS = 'cloudrend.srein.xyz';
const BEDROCK_ADDRESS = '15.235.159.75:25681';
const sql = neon(process.env.DATABASE_URL);

async function pingJava() {
  try {
    const res = await fetch(`https://api.mcsrvstat.us/3/${JAVA_ADDRESS}`, {
      headers: { 'User-Agent': 'CloudrendSMP-status-page' }
    });
    if (!res.ok) return { online: false, playerCount: null, maxPlayers: null, motd: null, players: [] };
    const data = await res.json();
    return {
      online: !!data.online,
      playerCount: data.players ? data.players.online : null,
      maxPlayers: data.players ? data.players.max : null,
      motd: data.motd && data.motd.clean ? data.motd.clean.join(' ') : null,
      players: (data.players && Array.isArray(data.players.list))
        ? data.players.list.map(p => (typeof p === 'string' ? p : p.name)).filter(Boolean)
        : []
    };
  } catch (err) {
    return { online: false, playerCount: null, maxPlayers: null, motd: null, players: [] };
  }
}

async function pingBedrock() {
  try {
    const res = await fetch(`https://api.mcsrvstat.us/bedrock/3/${BEDROCK_ADDRESS}`, {
      headers: { 'User-Agent': 'CloudrendSMP-status-page' }
    });
    if (!res.ok) return { online: false, playerCount: null, maxPlayers: null, motd: null };
    const data = await res.json();
    return {
      online: !!data.online,
      playerCount: data.players ? data.players.online : null,
      maxPlayers: data.players ? data.players.max : null,
      motd: data.motd && data.motd.clean ? data.motd.clean.join(' ') : null
    };
  } catch (err) {
    return { online: false, playerCount: null, maxPlayers: null, motd: null };
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
    const [java, bedrock] = await Promise.all([pingJava(), pingBedrock()]);
    const latest = await getLatestRow();

    const online = java.online || bedrock.online;
    const playerCount = (java.playerCount || 0) + (bedrock.playerCount || 0);
    const maxPlayers = (java.maxPlayers || 0) + (bedrock.maxPlayers || 0);
    const motd = java.motd || bedrock.motd || null;

    // Prefer the live Java name list (real-time, no setup needed). If Java
    // hides its sample, fall back to whatever's been pushed via POST.
    const players = java.players.length ? java.players : (latest ? latest.players : []);

    res.setHeader('Cache-Control', 's-maxage=15, stale-while-revalidate=30');
    return res.status(200).json({
      online,
      playerCount,
      maxPlayers,
      motd,
      players,
      java: { online: java.online, playerCount: java.playerCount, maxPlayers: java.maxPlayers },
      bedrock: { online: bedrock.online, playerCount: bedrock.playerCount, maxPlayers: bedrock.maxPlayers },
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