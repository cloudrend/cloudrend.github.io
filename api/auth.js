import { randomUUID } from 'crypto';

const SCOPES = 'identify%20email';

export default function handler(req, res) {
  const { DISCORD_CLIENT_ID, DISCORD_REDIRECT_URI } = process.env;

  if (!DISCORD_CLIENT_ID || !DISCORD_REDIRECT_URI) {
    return res.status(500).json({ error: 'Discord OAuth not configured.' });
  }

  // ── CSRF protection: generate state token ──
  const state = randomUUID();

  // Store in HTTP-only, Secure, SameSite=Lax cookie — short lived (10 min)
  res.setHeader('Set-Cookie', [
    `oauth_state=${state}; HttpOnly; Secure; SameSite=Lax; Max-Age=600; Path=/`,
  ]);

  const url =
    `https://discord.com/api/oauth2/authorize` +
    `?client_id=${DISCORD_CLIENT_ID}` +
    `&redirect_uri=${encodeURIComponent(DISCORD_REDIRECT_URI)}` +
    `&response_type=code` +
    `&scope=${SCOPES}` +
    `&state=${state}` +
    `&prompt=none`;

  return res.redirect(url);
}
