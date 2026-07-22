import { sql } from '@vercel/postgres';
import jwt from 'jsonwebtoken';

const ALLOWED_ORIGIN = 'https://cloudrend.vercel.app';

// Parse cookies from request header
function parseCookies(req) {
  const raw = req.headers.cookie ?? '';
  return Object.fromEntries(
    raw.split(';').map(c => c.trim().split('=').map(decodeURIComponent))
  );
}

export default async function handler(req, res) {
  // ── Restrict CORS to own domain ──
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);

  const { code, state: returnedState, error } = req.query;

  if (error) return res.redirect(`/auth.html?error=discord_denied`);
  if (!code || !returnedState) return res.redirect(`/auth.html?error=missing_params`);

  // ── CSRF: validate state against cookie ──
  const cookies = parseCookies(req);
  const expectedState = cookies['oauth_state'];

  if (!expectedState || expectedState !== returnedState) {
    return res.redirect(`/auth.html?error=csrf_mismatch`);
  }

  // Clear the state cookie immediately — single use
  res.setHeader('Set-Cookie', [
    `oauth_state=; HttpOnly; Secure; SameSite=Lax; Max-Age=0; Path=/`,
  ]);

  const {
    DISCORD_CLIENT_ID,
    DISCORD_CLIENT_SECRET,
    DISCORD_REDIRECT_URI,
    JWT_SECRET,
  } = process.env;

  try {
    // ── Step 1: Exchange code for access token (5s timeout) ──
    const tokenRes = await Promise.race([
      fetch('https://discord.com/api/oauth2/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id:     DISCORD_CLIENT_ID,
          client_secret: DISCORD_CLIENT_SECRET,
          grant_type:    'authorization_code',
          code,
          redirect_uri:  DISCORD_REDIRECT_URI,
        }),
      }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('token_timeout')), 5000)
      ),
    ]);

    if (!tokenRes.ok) {
      console.error('[discord-callback] token exchange failed:', await tokenRes.text());
      return res.redirect(`/auth.html?error=token_exchange`);
    }

    const { access_token } = await tokenRes.json();

    // ── Step 2: Fetch Discord user (4s timeout) ──
    const userRes = await Promise.race([
      fetch('https://discord.com/api/users/@me', {
        headers: { Authorization: `Bearer ${access_token}` },
      }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('user_fetch_timeout')), 4000)
      ),
    ]);

    if (!userRes.ok) return res.redirect(`/auth.html?error=user_fetch`);

    const { id: discord_id, username: discord_username, avatar } = await userRes.json();

    const discord_avatar = avatar
      ? `https://cdn.discordapp.com/avatars/${discord_id}/${avatar}.png?size=256`
      : `https://cdn.discordapp.com/embed/avatars/${Number(BigInt(discord_id) % 5n)}.png`;

    // ── Step 3: Upsert user ──
    const { rows } = await sql`
      INSERT INTO users (discord_id, discord_username, discord_avatar, status, role)
      VALUES (${discord_id}, ${discord_username}, ${discord_avatar}, 'active', 'member')
      ON CONFLICT (discord_id) DO UPDATE
        SET discord_username = EXCLUDED.discord_username,
            discord_avatar   = EXCLUDED.discord_avatar
      RETURNING id, discord_id, discord_username, discord_avatar,
                mc_username, status, ban_reason, role
    `;

    const user = rows[0];

    // ── Step 4: Block banned users immediately ──
    if (user.status === 'banned') {
      const reason = encodeURIComponent(user.ban_reason ?? 'No reason provided.');
      return res.redirect(`/auth.html?banned=1&reason=${reason}`);
    }

    // ── Step 5: Issue JWT ──
    const token = jwt.sign(
      { id: user.id, discord_id: user.discord_id, username: user.discord_username, role: user.role },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    // ── Step 6: Redirect ──
    const dest = user.mc_username ? '/portal.html' : '/link-mc.html';
    return res.redirect(`${dest}#token=${token}`);

  } catch (err) {
    console.error('[discord-callback] unhandled error:', err.message);
    const isTimeout = err.message.includes('timeout');
    return res.redirect(`/auth.html?error=${isTimeout ? 'timeout' : 'server_error'}`);
  }
}
