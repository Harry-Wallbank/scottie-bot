const { ChannelType } = require('discord.js');
const config = require('../config');
const dmAgent = require('../lib/dmAgent');
const { requestsReceived, messagesSent } = require('../lib/metrics');

module.exports = {
  name: 'messageCreate',
  async execute(message) {
    if (message.author.bot) return;
    if (message.channel.type !== ChannelType.DM) return;
    if (!config.ownerId || message.author.id !== config.ownerId) return;
    requestsReceived.inc({ type: 'dm' });
    await dmAgent.handleDm(message);
    messagesSent.inc({ type: 'dm' });
  },
};
