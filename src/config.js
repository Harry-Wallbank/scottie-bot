require('dotenv').config();

function required(name) {
  const value = process.env[name];
  if (!value) {
    console.error(
      `Missing required environment variable: ${name}\n` +
        'The bot refuses to start without it. Create a .env file (copy .env.example) ' +
        'with real values, or set it in your host/platform\'s environment variables.'
    );
    process.exit(1);
  }
  return value;
}

module.exports = {
  token: required('DISCORD_TOKEN'),
  clientId: required('CLIENT_ID'),
  guildId: process.env.GUILD_ID || null,
  autoRoleId: process.env.AUTO_ROLE_ID || null,
  tarkovAccessRoleId: process.env.TARKOV_ACCESS_ROLE_ID || null,
  tarkovAccessUserIds: (process.env.TARKOV_ACCESS_USER_IDS || '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean),
};
