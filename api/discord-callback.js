import { sql } from '@vercel/postgres';
import jwt from 'jsonwebtoken';

// Parse cookies from request header
function parseCookies(req) {
  const raw = req.headers.cookie ?? '';
  return Object.fromEntries(
    raw.split(';').map(c => c.trim().split('=').map(decodeURIComponent))
  );
}

export default async function handler(req, res) {
  const { code, state: returnedState, error } = req.query;

  if (error) {
    res.writeHead(302, { Location: '/auth.html?error=discord_denied' });
    return res.end();
  }
  if (!code || !returnedState) {
    res.writeHead(302, { Location: '/auth.html?error=missing_params' });
    return res.end();
  }

  // ── CSRF: validate state against cookie ──
  const cookies = parseCookies(req);
  const expectedState = cookies['oauth_state'];

  if (!expectedState || expectedState !== returnedState) {
    res.writeHead(302, { Location: '/auth.html?error=csrf_mismatch' });
    return res.end();
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
      res.writeHead(302, { Location: '/auth.html?error=token_exchange' });
      return res.end();
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

    if (!userRes.ok) {
      res.writeHead(302, { Location: '/auth.html?error=user_fetch' });
      return res.end();
    }

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
      res.writeHead(302, { Location: `/auth.html?banned=1&reason=${reason}` });
      return res.end();
    }

    // ── Step 5: Issue JWT ──
    const token = jwt.sign(
      { id: user.id, discord_id: user.discord_id, username: user.discord_username, role: user.role },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    // ── Step 6: Redirect ──
    const dest = user.mc_username ? '/portal.html' : '/link-mc.html';
    res.writeHead(302, { Location: `${dest}#token=${token}` });
    return res.end();

  } catch (err) {
    console.error('[discord-callback] unhandled error:', err.message);
    const isTimeout = err.message.includes('timeout');
    res.writeHead(302, { Location: `/auth.html?error=${isTimeout ? 'timeout' : 'server_error'}` });
    return res.end();
  }
}
