// Sends a message to a Discord channel via the Bot API on new application submissions.
// Requires DISCORD_BOT_TOKEN env var (a bot token, NOT the OAuth client secret —
// the bot must be a member of the server and have "Send Messages" permission
// in the target channel).
//
// This never throws upward: a Discord outage or bad token should not block
// an applicant's submission from being saved to the database. Failures are
// logged server-side only.

const STAFF_APP_CHANNEL_ID = '1504278051461005402';

export async function notifyDiscordChannel(channelId, embed) {
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) {
    console.error('[discord-notify] DISCORD_BOT_TOKEN is not set — skipping notification.');
    return false;
  }

  try {
    const res = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
      method: 'POST',
      headers: {
        'Authorization': `Bot ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ embeds: [embed] }),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      console.error(`[discord-notify] Discord API returned ${res.status}:`, errText);
      return false;
    }
    return true;
  } catch (err) {
    console.error('[discord-notify] Failed to reach Discord API:', err);
    return false;
  }
}

export function buildStaffApplicationEmbed(app) {
  return {
    title: '📋 New Staff Application',
    color: 0x6750A4,
    fields: [
      { name: 'IGN', value: app.ign, inline: true },
      { name: 'Discord', value: app.discord_username, inline: true },
      { name: 'Identity', value: app.identity_method === 'discord_oauth' ? '✅ Verified' : '⚠️ Self-reported', inline: true },
      { name: 'Age', value: String(app.age), inline: true },
      { name: 'Time Zone', value: app.timezone, inline: true },
      { name: 'Hours/week', value: app.hours_per_week, inline: true },
    ],
    footer: { text: `Application #${app.id} · Review in the staff portal` },
    timestamp: new Date().toISOString(),
  };
}

export function buildCreatorApplicationEmbed(app) {
  const platforms = (app.social_links ?? [])
    .map(l => `${l.platform}${l.followers ? ` (${Number(l.followers).toLocaleString()})` : ''}`)
    .join(', ') || 'None listed';

  return {
    title: '🎬 New Content Creator Application',
    color: 0x9C4DCC,
    fields: [
      { name: 'IGN', value: app.ign, inline: true },
      { name: 'Discord', value: app.discord_username, inline: true },
      { name: 'Content Type', value: app.content_type, inline: true },
      { name: 'Upload Frequency', value: app.upload_frequency, inline: true },
      { name: 'Avg Views', value: app.avg_views, inline: true },
      { name: 'Platforms', value: platforms, inline: false },
    ],
    footer: { text: `Application #${app.id} · Review in the staff portal` },
    timestamp: new Date().toISOString(),
  };
}

export { STAFF_APP_CHANNEL_ID };
