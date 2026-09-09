const { requestsReceived, messagesSent } = require('../lib/metrics');

// Routes a customId-bearing interaction (modal submit, button click, ...) to
// whichever loaded command owns it, matched by customId prefix
// (`${command.data.name}_...`), and calls `command[handlerName]`.
async function dispatchByCustomId(interaction, client, handlerName, label) {
  for (const command of client.commands.values()) {
    if (typeof command[handlerName] !== 'function' || !interaction.customId.startsWith(`${command.data.name}_`)) continue;
    try {
      await command[handlerName](interaction);
      messagesSent.inc({ type: 'command' });
    } catch (error) {
      console.error(`Error in /${command.data.name} ${label}:`, error);
      const payload = { content: 'Something went wrong processing that.', ephemeral: true };
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp(payload).catch(() => {});
      } else {
        await interaction.reply(payload).catch(() => {});
      }
      messagesSent.inc({ type: 'command' });
    }
    return;
  }
}

module.exports = {
  name: 'interactionCreate',
  async execute(interaction, client) {
    if (interaction.isAutocomplete()) {
      const command = client.commands.get(interaction.commandName);
      if (!command?.autocomplete) return;
      try {
        await command.autocomplete(interaction);
      } catch (error) {
        console.error(`Error in /${interaction.commandName} autocomplete:`, error);
        await interaction.respond([]).catch(() => {});
      }
      return;
    }

    if (interaction.isModalSubmit()) {
      requestsReceived.inc({ type: 'command' });
      await dispatchByCustomId(interaction, client, 'modalSubmit', 'modal submit');
      return;
    }

    if (interaction.isButton()) {
      requestsReceived.inc({ type: 'command' });
      await dispatchByCustomId(interaction, client, 'buttonClick', 'button click');
      return;
    }

    if (!interaction.isChatInputCommand()) return;

    const command = client.commands.get(interaction.commandName);
    if (!command) return;

    requestsReceived.inc({ type: 'command' });
    try {
      await command.execute(interaction);
      messagesSent.inc({ type: 'command' });
    } catch (error) {
      console.error(`Error executing /${interaction.commandName}:`, error);
      const payload = {
        content: 'Something went wrong running that command.',
        ephemeral: true,
      };
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp(payload).catch(() => {});
      } else {
        await interaction.reply(payload).catch(() => {});
      }
      messagesSent.inc({ type: 'command' });
    }
  },
};
