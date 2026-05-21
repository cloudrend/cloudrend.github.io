// Shared auth helper — import this in every protected API route
// Handles JWT verification + banned check + DB re-validation in one place

import { sql } from '@vercel/postgres';
import jwt from 'jsonwebtoken';

export const ALLOWED_ORIGIN = 'https://cloudrend.vercel.app';

export function setCORSHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-bridge-secret');
  res.setHeader('Vary', 'Origin');
}

/**
 * Verifies JWT + re-validates against DB + blocks banned users.
 * Returns the full user row on success, or null (after sending error) on failure.
 *
 * @param {object} req
 * @param {object} res
 * @param {object} options
 * @param {boolean} options.requireStaff - if true, also checks role is mod/admin/owner
 * @param {boolean} options.allowBanned  - if true, skips the banned check (used by /api/appeal)
 */
export async function verifyAuth(req, res, { requireStaff = false, allowBanned = false } = {}) {
  const auth = req.headers['authorization'];
  if (!auth?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing or malformed Authorization header.' });
    return null;
  }

  let payload;
  try {
    payload = jwt.verify(auth.slice(7).trim(), process.env.JWT_SECRET);
  } catch (err) {
    res.status(401).json({
      error: err.name === 'TokenExpiredError'
        ? 'Session expired. Please log in again.'
        : 'Invalid session token.',
    });
    return null;
  }

  let user;
  try {
    const { rows, rowCount } = await sql`
      SELECT id, discord_id, discord_username, discord_avatar,
             mc_username, status, ban_reason, role, avatar_url, bio
      FROM users
      WHERE id = ${payload.id} AND discord_id = ${payload.discord_id}
      LIMIT 1
    `;
    if (rowCount === 0) {
      res.status(401).json({ error: 'Session invalid. User not found.' });
      return null;
    }
    user = rows[0];
  } catch (err) {
    console.error('[verifyAuth] DB error:', err);
    res.status(500).json({ error: 'Internal server error.' });
    return null;
  }

  // Block banned users on every protected route
  if (!allowBanned && user.status === 'banned') {
    res.status(403).json({
      error: 'You are banned from Cloudrend SMP.',
      banned: true,
      ban_reason: user.ban_reason ?? 'No reason provided.',
    });
    return null;
  }

  // Staff gate
  const STAFF_ROLES = ['mod', 'admin', 'owner'];
  if (requireStaff && !STAFF_ROLES.includes(user.role)) {
    res.status(403).json({ error: 'Forbidden. Staff only.' });
    return null;
  }

  return user;
}