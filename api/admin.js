import { sql } from '@vercel/postgres';
import { verifyAuth, setCORSHeaders } from './auth-helper.js';

// Role hierarchy — higher index = more power
const ROLE_HIERARCHY = ['member', 'builder', 'developer', 'mod', 'admin', 'owner'];
const STAFF_ROLES = ['mod', 'admin', 'owner']; // can access admin panel

function roleRank(role) {
  const idx = ROLE_HIERARCHY.indexOf(role);
  return idx === -1 ? 0 : idx;
}

async function ensureWarningsTable() {
  await sql`
    CREATE TABLE IF NOT EXISTS warnings (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      staff_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      staff_name text NOT NULL,
      reason text,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `;
}

async function resolveStaff(req, res) {
  const auth = req.headers['authorization'];
  if (!auth?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing Authorization header.' });
    return null;
  }
  const token = auth.slice(7).trim();
  let username, id;
  try {
    const decoded = Buffer.from(token, 'base64').toString('utf-8');
    [username, id] = decoded.split(':');
    if (!username || !id || isNaN(Number(id))) throw new Error();
  } catch {
    res.status(401).json({ error: 'Invalid token.' });
    return null;
  }

  const { rows, rowCount } = await sql`
    SELECT id, username, role FROM users
    WHERE id = ${Number(id)} AND username = ${username} LIMIT 1
  `;
  if (rowCount === 0) { res.status(401).json({ error: 'Session invalid.' }); return null; }

  const user = rows[0];
  if (!STAFF_ROLES.includes(user.role)) {
    res.status(403).json({ error: 'Forbidden. Staff only.' });
    return null;
  }
  return user;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const staff = await resolveStaff(req, res);
  if (!staff) return;

  const { action } = req.query;

  // ---- GET users ----
  if (req.method === 'GET' && action === 'users') {
    await ensureWarningsTable();
    const { rows } = await sql`
      SELECT u.id, u.username, u.role, u.status, u.ban_reason, u.avatar_url, u.bio,
        COALESCE(w.count, 0) AS warning_count
      FROM users u
      LEFT JOIN (
        SELECT user_id, COUNT(*) AS count FROM warnings GROUP BY user_id
      ) w ON w.user_id = u.id
      ORDER BY
        CASE u.role
          WHEN 'owner' THEN 1 WHEN 'admin' THEN 2 WHEN 'mod' THEN 3
          WHEN 'developer' THEN 4 WHEN 'builder' THEN 5 ELSE 6
        END, u.username ASC
    `;
    return res.status(200).json({ users: rows });
  }

  // ---- POST ban ----
  if (req.method === 'POST' && action === 'ban') {
    const { username, reason } = req.body ?? {};
    if (!username) return res.status(400).json({ error: 'Username required.' });

    const { rows, rowCount } = await sql`SELECT role FROM users WHERE LOWER(username) = LOWER(${username}) LIMIT 1`;
    if (rowCount === 0) return res.status(404).json({ error: 'User not found.' });

    // Can't ban someone of equal or higher rank
    if (roleRank(rows[0].role) >= roleRank(staff.role)) {
      return res.status(403).json({ error: `You can't ban someone with role: ${rows[0].role}.` });
    }

    await sql`UPDATE users SET status = 'banned', ban_reason = ${reason ?? 'No reason provided.'} WHERE LOWER(username) = LOWER(${username})`;
    return res.status(200).json({ message: `${username} has been banned.` });
  }

  // ---- POST unban ----
  if (req.method === 'POST' && action === 'unban') {
    const { username } = req.body ?? {};
    if (!username) return res.status(400).json({ error: 'Username required.' });
    const { rowCount } = await sql`UPDATE users SET status = 'active', ban_reason = NULL WHERE LOWER(username) = LOWER(${username})`;
    if (rowCount === 0) return res.status(404).json({ error: 'User not found.' });
    return res.status(200).json({ message: `${username} has been unbanned.` });
  }

  // ---- POST setrole ----
  if (req.method === 'POST' && action === 'setrole') {
    const { username, role } = req.body ?? {};
    if (!username || !role) return res.status(400).json({ error: 'Username and role required.' });
    if (!ROLE_HIERARCHY.includes(role)) {
      return res.status(400).json({ error: `Invalid role. Valid: ${ROLE_HIERARCHY.join(', ')}` });
    }

    const { rows, rowCount } = await sql`SELECT id, role FROM users WHERE LOWER(username) = LOWER(${username}) LIMIT 1`;
    if (rowCount === 0) return res.status(404).json({ error: 'User not found.' });

    const targetCurrentRank = roleRank(rows[0].role);
    const targetNewRank = roleRank(role);
    const staffRank = roleRank(staff.role);

    if (targetCurrentRank >= staffRank) {
      return res.status(403).json({ error: `Can't modify someone with role: ${rows[0].role}.` });
    }
    if (targetNewRank >= staffRank) {
      return res.status(403).json({ error: `Can't assign role: ${role}. Exceeds your rank.` });
    }

    await sql`UPDATE users SET role = ${role} WHERE LOWER(username) = LOWER(${username})`;
    return res.status(200).json({ message: `${username} is now ${role}.` });
  }

  // ---- POST warn ----
  if (req.method === 'POST' && action === 'warn') {
    const { username, reason } = req.body ?? {};
    if (!username) return res.status(400).json({ error: 'Username required.' });

    const { rows, rowCount } = await sql`SELECT id, role FROM users WHERE LOWER(username) = LOWER(${username}) LIMIT 1`;
    if (rowCount === 0) return res.status(404).json({ error: 'User not found.' });

    if (roleRank(rows[0].role) >= roleRank(staff.role)) {
      return res.status(403).json({ error: `You can't warn someone with role: ${rows[0].role}.` });
    }

    await ensureWarningsTable();
    await sql`
      INSERT INTO warnings (user_id, staff_id, staff_name, reason)
      VALUES (${rows[0].id}, ${staff.id}, ${staff.username}, ${reason ?? 'No reason provided.'})
    `;

    const { rows: warnCountRows } = await sql`SELECT COUNT(*)::int AS count FROM warnings WHERE user_id = ${rows[0].id}`;
    return res.status(200).json({ message: `${username} has been warned. (${warnCountRows[0].count} total warnings)` });
  }

  // ---- DELETE account ----
  if (req.method === 'DELETE' && action === 'delete') {
    const { username } = req.body ?? {};
    if (!username) return res.status(400).json({ error: 'Username required.' });

    const { rows, rowCount } = await sql`SELECT role FROM users WHERE LOWER(username) = LOWER(${username}) LIMIT 1`;
    if (rowCount === 0) return res.status(404).json({ error: 'User not found.' });

    if (roleRank(rows[0].role) >= roleRank(staff.role)) {
      return res.status(403).json({ error: `Can't delete someone with role: ${rows[0].role}.` });
    }

    await sql`DELETE FROM users WHERE LOWER(username) = LOWER(${username})`;
    return res.status(200).json({ message: `${username} has been deleted.` });
  }

  return res.status(400).json({ error: `Unknown action: ${action}` });
}
