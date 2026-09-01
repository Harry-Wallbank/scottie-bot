const { SlashCommandBuilder } = require('discord.js');
const profileStore = require('../lib/tarkovProfileStore');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('wipe')
    .setDescription('Reset your saved player/trader level for /metabuild after a game wipe or prestige')
    .setDMPermission(true),

  async execute(interaction) {
    const existed = profileStore.deleteProfile(interaction.user.id);

    await interaction.reply({
      content: existed
        ? "Your saved player/trader level has been reset. The next time you run `/metabuild`, you'll be asked to set them again."
        : "You didn't have a saved profile yet — nothing to reset. `/metabuild` will ask you to set one the next time you use it.",
      ephemeral: true,
    });
  },
};
