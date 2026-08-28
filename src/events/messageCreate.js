const { ChannelType } = require('discord.js');
const config = require('../config');
const dmAgent = require('../lib/dmAgent');

module.exports = {
  name: 'messageCreate',
  async execute(message) {
    if (message.author.bot) return;
    if (message.channel.type !== ChannelType.DM) return;
    if (!config.ownerId || message.author.id !== config.ownerId) return;
    await dmAgent.handleDm(message);
  },
};
