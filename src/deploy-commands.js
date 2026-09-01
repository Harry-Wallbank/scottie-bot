const fs = require('node:fs');
const path = require('node:path');
const { REST, Routes } = require('discord.js');
const config = require('./config');

const commandsPath = path.join(__dirname, 'commands');

function loadCommands() {
  return fs
    .readdirSync(commandsPath)
    .filter((f) => f.endsWith('.js'))
    .map((f) => require(path.join(commandsPath, f)).data.toJSON());
}

// `dm_permission` is only respected on globally-scoped commands - a
// guild-scoped command is never invocable in DMs no matter how it's set.
// So DM-enabled commands must go global (up to ~1hr to propagate);
// everything else stays guild-scoped when GUILD_ID is set, for the near
// instant updates that makes iterating (including via the DM agent)
// practical.
async function registerCommands() {
  const commands = loadCommands();
  const rest = new REST({ version: '10' }).setToken(config.token);

  if (!config.guildId) {
    console.log(`Registering ${commands.length} slash command(s) globally...`);
    await rest.put(Routes.applicationCommands(config.clientId), { body: commands });
    console.log('Slash commands registered successfully.');
    return;
  }

  const dmEnabled = commands.filter((c) => c.dm_permission === true);
  const guildOnly = commands.filter((c) => c.dm_permission !== true);

  console.log(`Registering ${guildOnly.length} guild-only command(s) to guild ${config.guildId}...`);
  await rest.put(Routes.applicationGuildCommands(config.clientId, config.guildId), { body: guildOnly });

  console.log(`Registering ${dmEnabled.length} DM-enabled command(s) globally...`);
  await rest.put(Routes.applicationCommands(config.clientId), { body: dmEnabled });

  console.log('Slash commands registered successfully.');
}

if (require.main === module) {
  registerCommands().catch((error) => {
    console.error('Failed to register slash commands:', error);
    process.exitCode = 1;
  });
}

module.exports = { registerCommands };
