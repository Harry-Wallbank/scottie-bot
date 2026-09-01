const { SlashCommandBuilder } = require('discord.js');
const profileStore = require('../lib/tarkovProfileStore');
const { TRADER_CHUNKS, parseLevel, buildProfileModal, buildContinueButtonRow } = require('../lib/tarkovProfileModal');

// Command state stashed here while the modal chain is open, keyed by a
// short-lived token embedded in the modal's customId. In-memory only —
// if the bot restarts mid-flow, the user just gets a "run it again"
// message, an acceptable trade-off for not persisting throwaway state.
const pendingRequests = new Map();
const PENDING_TTL_MS = 10 * 60 * 1000;

module.exports = {
  data: new SlashCommandBuilder()
    .setName('updatetrader')
    .setDescription('Manually update your player/trader levels for /metabuild, ahead of the daily reconfirm')
    .setDMPermission(true),

  async execute(interaction) {
    const token = `${interaction.user.id}-${Date.now()}`;
    pendingRequests.set(token, {});
    setTimeout(() => pendingRequests.delete(token), PENDING_TTL_MS);

    const existingProfile = profileStore.getProfile(interaction.user.id);
    await interaction.showModal(buildProfileModal('updatetrader', 0, token, existingProfile));
  },

  async modalSubmit(interaction) {
    const match = interaction.customId.match(/^updatetrader_profile(\d+):(.+)$/);
    if (!match) return;
    const page = Number(match[1]);
    const token = match[2];
    const pending = pendingRequests.get(token);

    if (!pending) {
      await interaction.reply({ content: 'That took too long — run `/updatetrader` again.', ephemeral: true });
      return;
    }

    const chunk = TRADER_CHUNKS[page];
    if (page === 0) {
      const playerLevel = parseLevel(interaction.fields.getTextInputValue('playerLevel'), 1, 99);
      if (playerLevel === null) {
        pendingRequests.delete(token);
        await interaction.reply({ content: 'Player level must be a whole number between 1 and 99. Run `/updatetrader` again.', ephemeral: true });
        return;
      }
      pending.playerLevel = playerLevel;
    }

    const traderLevels = pending.traderLevels || {};
    for (const trader of chunk) {
      const level = parseLevel(interaction.fields.getTextInputValue(trader.id), 1, profileStore.MAX_TRADER_LEVEL);
      if (level === null) {
        pendingRequests.delete(token);
        await interaction.reply({
          content: `${trader.name}'s level must be a whole number between 1 and ${profileStore.MAX_TRADER_LEVEL}. Run \`/updatetrader\` again.`,
          ephemeral: true,
        });
        return;
      }
      traderLevels[trader.id] = level;
    }
    pending.traderLevels = traderLevels;

    if (page + 1 < TRADER_CHUNKS.length) {
      // A modal submission can't itself open another modal — Discord
      // requires a fresh interaction (a button click) for that — so prompt
      // a "Continue" button instead of chaining straight into page 2.
      await interaction.reply({
        content: `Got it. Click continue for the rest (${page + 2}/${TRADER_CHUNKS.length}).`,
        components: [buildContinueButtonRow('updatetrader', token, page + 1)],
        ephemeral: true,
      });
      return;
    }

    pendingRequests.delete(token);
    profileStore.setProfile(interaction.user.id, { playerLevel: pending.playerLevel, traderLevels: pending.traderLevels });

    await interaction.reply({
      content: "Your Tarkov profile is updated — `/metabuild` will use these levels immediately, and today's daily reconfirm is satisfied.",
      ephemeral: true,
    });
  },

  async buttonClick(interaction) {
    const match = interaction.customId.match(/^updatetrader_continue(\d+):(.+)$/);
    if (!match) return;
    const page = Number(match[1]);
    const token = match[2];

    if (!pendingRequests.has(token)) {
      await interaction.reply({ content: 'That took too long — run `/updatetrader` again.', ephemeral: true });
      return;
    }

    const existingProfile = profileStore.getProfile(interaction.user.id);
    await interaction.showModal(buildProfileModal('updatetrader', page, token, existingProfile));
  },
};
