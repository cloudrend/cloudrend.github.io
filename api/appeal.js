import { verifyAuth, setCORSHeaders } from './auth-helper.js';

export default async function handler(req, res) {
  setCORSHeaders(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  // allowBanned: true — banned users must be able to submit appeals
  const user = await verifyAuth(req, res, { allowBanned: true });
  if (!user) return;

  const { reason } = req.body ?? {};
  if (!reason?.trim()) return res.status(400).json({ error: 'Appeal reason is required.' });
  if (reason.trim().length < 20) return res.status(400).json({ error: 'Appeal must be at least 20 characters.' });

  const webhookUrl = process.env.APPEAL_WEBHOOK_URL;
  if (!webhookUrl) return res.status(500).json({ error: 'Appeal system not configured.' });

  const embed = {
    title: '📝 New Ban Appeal',
    color: 0x6750A4,
    fields: [
      { name: '👤 Discord', value: user.discord_username, inline: true },
      { name: '🎮 MC Username', value: user.mc_username ?? 'Not linked', inline: true },
      { name: '📅 Submitted', value: `<t:${Math.floor(Date.now()/1000)}:R>`, inline: true },
      { name: '📄 Appeal', value: reason.trim().slice(0, 1024) },
    ],
    footer: { text: 'Cloudrend SMP — Ban Appeal System' },
    timestamp: new Date().toISOString(),
  };

  try {
    const wRes = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'Appeal Bot', embeds: [embed] }),
    });
    if (!wRes.ok) return res.status(502).json({ error: 'Failed to deliver appeal. Try again.' });
    return res.status(200).json({ message: 'Appeal submitted successfully.' });
  } catch (err) {
    console.error('[appeal]', err);
    return res.status(500).json({ error: 'Internal server error.' });
  }
}