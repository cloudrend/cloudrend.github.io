// server.js — Cloudrend SMP Application Portal
// Express backend: serves the MD3 frontend and relays applications to Discord webhooks.

require('dotenv').config();

const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

const STAFF_WEBHOOK_URL = process.env.STAFF_WEBHOOK_URL;
const MEDIA_WEBHOOK_URL = process.env.MEDIA_WEBHOOK_URL;

// ---------- Middleware ----------
app.use(express.json({ limit: '100kb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Very small in-memory rate limiter (per-IP) to deter spam submissions.
// For production at scale, swap this for a Redis-backed limiter.
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX = 5;
const hits = new Map();

function rateLimit(req, res, next) {
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip;
  const now = Date.now();
  const windowStart = now - RATE_LIMIT_WINDOW_MS;

  const timestamps = (hits.get(ip) || []).filter((t) => t > windowStart);
  timestamps.push(now);
  hits.set(ip, timestamps);

  if (timestamps.length > RATE_LIMIT_MAX) {
    return res.status(429).json({ ok: false, error: 'Too many submissions. Please try again in a minute.' });
  }
  next();
}

// ---------- Helpers ----------

/**
 * Basic string sanitizer: trims, enforces max length, strips control chars.
 * Discord embeds handle markdown/escaping fine, so we don't need to HTML-escape here.
 */
function clean(value, maxLength = 1000) {
  if (typeof value !== 'string') return '';
  return value
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .trim()
    .slice(0, maxLength);
}

function isNonEmpty(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

async function postToDiscord(webhookUrl, embed) {
  if (!webhookUrl) {
    throw Object.assign(new Error('Webhook URL is not configured on the server.'), { code: 'NO_WEBHOOK' });
  }

  const response = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ embeds: [embed] }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Discord webhook responded with ${response.status}: ${body}`);
  }
}

// ---------- Routes ----------

/**
 * POST /api/apply/staff
 * Body: { position, ign, discord, violationHandling, whyHire, whyDeserving }
 */
app.post('/api/apply/staff', rateLimit, async (req, res) => {
  try {
    const VALID_POSITIONS = ['Helper', 'Moderator', 'Administrator', 'Builder'];

    const position = clean(req.body.position, 50);
    const ign = clean(req.body.ign, 32);
    const discord = clean(req.body.discord, 64);
    const violationHandling = clean(req.body.violationHandling, 1500);
    const whyHire = clean(req.body.whyHire, 1500);
    const whyDeserving = clean(req.body.whyDeserving, 1500);

    if (!VALID_POSITIONS.includes(position)) {
      return res.status(400).json({ ok: false, error: 'Please select a valid position.' });
    }
    if (![ign, discord, violationHandling, whyHire, whyDeserving].every(isNonEmpty)) {
      return res.status(400).json({ ok: false, error: 'Please fill out every field before submitting.' });
    }

    const embed = {
      title: '🛡️ New Staff Application',
      color: 0x8b5cf6, // purple
      fields: [
        { name: 'Position', value: position, inline: true },
        { name: 'Minecraft IGN', value: ign, inline: true },
        { name: 'Discord Username', value: discord, inline: true },
        { name: 'Handling rule violations by friends', value: violationHandling.slice(0, 1024) },
        { name: 'Reason to hire you', value: whyHire.slice(0, 1024) },
        { name: 'Why deserving of role', value: whyDeserving.slice(0, 1024) },
      ],
      footer: { text: 'Cloudrend SMP • Staff Applications' },
      timestamp: new Date().toISOString(),
    };

    await postToDiscord(STAFF_WEBHOOK_URL, embed);
    return res.json({ ok: true, message: 'Staff application submitted successfully!' });
  } catch (err) {
    console.error('[apply/staff] error:', err.message);
    return res.status(502).json({ ok: false, error: 'Could not deliver your application right now. Please try again shortly.' });
  }
});

/**
 * POST /api/apply/media
 * Body: { ign, discord, platform, link, followers, whyContent, sampleLinks }
 */
app.post('/api/apply/media', rateLimit, async (req, res) => {
  try {
    const VALID_PLATFORMS = ['YouTube', 'Twitch', 'TikTok', 'Kick'];

    const ign = clean(req.body.ign, 32);
    const discord = clean(req.body.discord, 64);
    const platform = clean(req.body.platform, 20);
    const link = clean(req.body.link, 300);
    const followers = clean(req.body.followers, 30);
    const whyContent = clean(req.body.whyContent, 1500);
    const sampleLinks = clean(req.body.sampleLinks, 500); // optional

    if (!VALID_PLATFORMS.includes(platform)) {
      return res.status(400).json({ ok: false, error: 'Please select a valid platform.' });
    }
    if (![ign, discord, link, followers, whyContent].every(isNonEmpty)) {
      return res.status(400).json({ ok: false, error: 'Please fill out every required field before submitting.' });
    }

    const embed = {
      title: '🎥 New Media Application',
      color: 0x22d3ee, // cyan
      fields: [
        { name: 'Platform', value: platform, inline: true },
        { name: 'Minecraft IGN', value: ign, inline: true },
        { name: 'Discord Username', value: discord, inline: true },
        { name: 'Channel / Stream Link', value: link },
        { name: 'Subscriber / Follower Count', value: followers, inline: true },
        { name: 'Why create content for Cloudrend SMP?', value: whyContent.slice(0, 1024) },
      ],
      footer: { text: 'Cloudrend SMP • Media Applications' },
      timestamp: new Date().toISOString(),
    };

    if (isNonEmpty(sampleLinks)) {
      embed.fields.push({ name: 'Sample Links', value: sampleLinks.slice(0, 1024) });
    }

    await postToDiscord(MEDIA_WEBHOOK_URL, embed);
    return res.json({ ok: true, message: 'Media application submitted successfully!' });
  } catch (err) {
    console.error('[apply/media] error:', err.message);
    return res.status(502).json({ ok: false, error: 'Could not deliver your application right now. Please try again shortly.' });
  }
});

// Simple health check
app.get('/api/health', (_req, res) => res.json({ ok: true }));

// Fallback to index.html for the root
app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`✅ Cloudrend SMP portal running at http://localhost:${PORT}`);
  if (!STAFF_WEBHOOK_URL) console.warn('⚠️  STAFF_WEBHOOK_URL is not set — staff applications will fail.');
  if (!MEDIA_WEBHOOK_URL) console.warn('⚠️  MEDIA_WEBHOOK_URL is not set — media applications will fail.');
});
