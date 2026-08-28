const { SlashCommandBuilder } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('ping')
    .setDescription("Replies with the bot's latency and WebSocket heartbeat"),

  async execute(interaction) {
    const sent = await interaction.reply({
      content: 'Pinging...',
      fetchReply: true,
      ephemeral: true,
    });

    const roundtrip = sent.createdTimestamp - interaction.createdTimestamp;
    const wsPing = Math.round(interaction.client.ws.ping);

    await interaction.editReply({
      content: `🏓 Pong!\n• **Roundtrip Latency:** ${roundtrip}ms\n• **WebSocket Ping:** ${wsPing}ms`,
    });
  },
};
