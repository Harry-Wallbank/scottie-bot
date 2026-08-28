const fs = require('node:fs');
const path = require('node:path');
const { REST, Routes } = require('discord.js');
const config = require('./config');

async function registerCommands() {
  const commandsPath = path.join(__dirname, 'commands');
  const commands = [];
  for (const file of fs.readdirSync(commandsPath).filter((f) => f.endsWith('.js'))) {
    const filePath = path.join(commandsPath, file);
    delete require.cache[require.resolve(filePath)];
    const command = require(filePath);
    commands.push(command.data.toJSON());
  }

  const rest = new REST({ version: '10' }).setToken(config.token);
  const route = config.guildId
    ? Routes.applicationGuildCommands(config.clientId, config.guildId)
    : Routes.applicationCommands(config.clientId);

  const scope = config.guildId ? `guild ${config.guildId}` : 'global';
  console.log(`Registering ${commands.length} slash command(s) to ${scope}...`);

  await rest.put(route, { body: commands });

  console.log('Slash commands registered successfully.');
  return commands.length;
}

if (require.main === module) {
  registerCommands().catch((error) => {
    console.error('Failed to register slash commands:', error);
    process.exitCode = 1;
  });
}

module.exports = { registerCommands };
