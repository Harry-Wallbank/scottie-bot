const { SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const config = require('../config');

// /cleardm - the owner clears the bot's own messages from the channel the command is sent in.
// In a DM that is the DM; in a server channel it is that channel only. Nothing else is touched.
//
//   /cleardm count amount:25                       the most recent 25 bot messages
//   /cleardm range from:2026-10-11 02:05           everything since then, until now
//   /cleardm range from:2026-10-11 02:05 until:2026-10-12 18:00
//   /cleardm range from:36h                        the last 36 hours
//
// Only the bot's own messages are ever deleted; everyone else's, including the
// owner's, stay. It always shows how many messages it found and asks for a button
// press first.

const DEFAULT_TZ = 'America/Edmonton';
const MAX_COUNT = 1000;
const MAX_SCAN = 5000;           // messages looked through for a range
const PENDING_MS = 2 * 60 * 1000;
const pending = new Map();       // token -> { userId, channelId, ids, label, expires }

function offsetMs(utcMs, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(utcMs));
  const p = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - utcMs;
}

// A wall-clock time in `timeZone` -> UTC milliseconds.
function zonedToUtc(y, mo, d, h, mi, timeZone) {
  const wall = Date.UTC(y, mo - 1, d, h, mi);
  let utc = wall - offsetMs(wall, timeZone);
  utc = wall - offsetMs(utc, timeZone);
  return utc;
}

// "now", a relative span ("36h", "1d12h", "90m"), an ISO time with a zone
// ("2026-10-11T08:05:00Z"), or "YYYY-MM-DD [HH:MM]" in the given time zone.
function parseWhen(input, timeZone) {
  const text = input.trim();
  const lower = text.toLowerCase();
  if (lower === 'now') return Date.now();

  const rel = lower.match(/^(?:(\d+)d)?(?:(\d+)h)?(?:(\d+)m)?$/);
  if (rel && lower) {
    const ms = ((+rel[1] || 0) * 1440 + (+rel[2] || 0) * 60 + (+rel[3] || 0)) * 60000;
    return ms > 0 ? Date.now() - ms : null;
  }

  if (/(z|[+-]\d\d:?\d\d)$/i.test(text) && /^\d{4}-\d{2}-\d{2}t/i.test(text)) {
    const parsed = Date.parse(text);
    return Number.isNaN(parsed) ? null : parsed;
  }

  const m = text.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2}))?$/);
  if (m) return zonedToUtc(+m[1], +m[2], +m[3], +(m[4] || 0), +(m[5] || 0), timeZone);
  return null;
}

function validZone(zone) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

function shortTime(ms, timeZone) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone, dateStyle: 'medium', timeStyle: 'short',
  }).format(new Date(ms));
}

// Walks the channel history newest-first and returns the bot's own messages that match.
async function collect(channel, botId, { count, since, until }) {
  const ids = [];
  let before;
  let scanned = 0;
  while (scanned < MAX_SCAN) {
    const batch = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
    if (batch.size === 0) break;
    const ordered = [...batch.values()]; // newest first
    scanned += ordered.length;
    let reachedOlder = false;
    for (const message of ordered) {
      if (since != null && message.createdTimestamp < since) {
        reachedOlder = true;
        continue;
      }
      if (message.author.id !== botId) continue;
      if (until != null && message.createdTimestamp > until) continue;
      ids.push(message.id);
      if (count != null && ids.length >= count) return { ids, scanned };
    }
    before = ordered[ordered.length - 1].id;
    if (reachedOlder || batch.size < 100) break;
  }
  return { ids, scanned };
}

function expire() {
  const now = Date.now();
  for (const [token, job] of pending) if (job.expires < now) pending.delete(token);
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('cleardm')
    .setDescription("Owner only: delete the bot's own messages in this channel (this DM, or this server channel)")
    .setDMPermission(true)
    .addSubcommand((sub) => sub
      .setName('count')
      .setDescription('Delete the most recent X of the bot\'s messages')
      .addIntegerOption((o) => o
        .setName('amount')
        .setDescription(`How many of the newest bot messages to delete (1-${MAX_COUNT})`)
        .setRequired(true)
        .setMinValue(1)
        .setMaxValue(MAX_COUNT)))
    .addSubcommand((sub) => sub
      .setName('range')
      .setDescription('Delete the bot\'s messages sent between two times')
      .addStringOption((o) => o
        .setName('from')
        .setDescription('Start: "2026-10-11 02:05", "36h" (hours ago), "1d12h", or an ISO time with Z')
        .setRequired(true))
      .addStringOption((o) => o
        .setName('until')
        .setDescription('End (same formats). Leave empty for now.'))
      .addStringOption((o) => o
        .setName('timezone')
        .setDescription(`Time zone for plain dates (default ${DEFAULT_TZ})`))),

  async execute(interaction) {
    if (!config.ownerId || interaction.user.id !== config.ownerId) {
      await interaction.reply({ content: 'This command is owner only.', ephemeral: true });
      return;
    }
    await interaction.deferReply({ ephemeral: true });

    const sub = interaction.options.getSubcommand();
    const timeZone = (sub === 'range' && interaction.options.getString('timezone')) || DEFAULT_TZ;
    if (!validZone(timeZone)) {
      await interaction.editReply(`"${timeZone}" is not a time zone I know. Try something like America/Edmonton or UTC.`);
      return;
    }

    let spec;
    let label;
    if (sub === 'count') {
      const amount = interaction.options.getInteger('amount');
      spec = { count: amount };
      label = `the ${amount} most recent`;
    } else {
      const since = parseWhen(interaction.options.getString('from'), timeZone);
      const untilText = interaction.options.getString('until');
      const until = untilText ? parseWhen(untilText, timeZone) : Date.now();
      if (since == null || until == null) {
        await interaction.editReply('I could not read that time. Use "2026-10-11 02:05", "36h" (hours ago), "1d12h" or an ISO time ending in Z.');
        return;
      }
      if (since >= until) {
        await interaction.editReply('"from" has to be earlier than "until".');
        return;
      }
      spec = { since, until };
      label = `sent between ${shortTime(since, timeZone)} and ${shortTime(until, timeZone)} (${timeZone})`;
    }

    let channel;
    try {
      channel = interaction.channel ?? await interaction.client.channels.fetch(interaction.channelId);
    } catch {
      channel = null;
    }
    if (!channel || !channel.isTextBased()) {
      await interaction.editReply('I cannot see the channel you ran this in.');
      return;
    }
    const where = channel.isDMBased() ? 'this DM' : `#${channel.name}`;

    let found;
    try {
      found = await collect(channel, interaction.client.user.id, spec);
    } catch (error) {
      console.error('cleardm: could not read history', error.message);
      await interaction.editReply(`I cannot read the message history in ${where} (I need View Channel and Read Message History there).`);
      return;
    }
    const { ids, scanned } = found;
    if (ids.length === 0) {
      await interaction.editReply(`I looked through ${scanned} messages in ${where} and found none of mine ${sub === 'count' ? 'to delete' : label}.`);
      return;
    }

    expire();
    const token = `${interaction.id}`;
    pending.set(token, { userId: interaction.user.id, channelId: channel.id, where, ids, label, expires: Date.now() + PENDING_MS });
    await interaction.editReply({
      content: `Found **${ids.length}** of my messages in **${where}** (${label}), out of ${scanned} looked at. Delete them? Everyone else's messages stay. This cannot be undone.`,
      components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`cleardm_yes_${token}`).setLabel(`Delete ${ids.length}`).setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId(`cleardm_no_${token}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary),
      )],
    });
  },

  async buttonClick(interaction) {
    const [, action, token] = interaction.customId.split('_');
    const job = pending.get(token);
    if (!job || job.userId !== interaction.user.id || job.expires < Date.now()) {
      pending.delete(token);
      await interaction.update({ content: 'That request expired. Run /cleardm again.', components: [] });
      return;
    }
    pending.delete(token);
    if (action !== 'yes') {
      await interaction.update({ content: 'Cancelled. Nothing was deleted.', components: [] });
      return;
    }

    await interaction.update({ content: `Deleting ${job.ids.length} messages in ${job.where}...`, components: [] });
    const channel = await interaction.client.channels.fetch(job.channelId).catch(() => null);
    if (!channel) {
      await interaction.editReply('I can no longer see that channel, so nothing was deleted.');
      return;
    }
    let deleted = 0;
    let missing = 0;
    for (const id of job.ids) {
      try {
        await channel.messages.delete(id);
        deleted += 1;
      } catch (error) {
        if (error.code === 10008) missing += 1; // already gone
        else console.error('cleardm: could not delete', id, error.message);
      }
      if ((deleted + missing) % 25 === 0) {
        await interaction.editReply(`Deleting... ${deleted + missing}/${job.ids.length}`).catch(() => {});
      }
    }
    const failed = job.ids.length - deleted - missing;
    await interaction.editReply(
      `Done. Deleted ${deleted} message${deleted === 1 ? '' : 's'} in ${job.where}`
      + (missing ? `, ${missing} were already gone` : '')
      + (failed ? `, ${failed} could not be deleted (see the bot log)` : '')
      + '.',
    );
  },
};
