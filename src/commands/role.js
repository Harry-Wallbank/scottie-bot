const { SlashCommandBuilder, PermissionFlagsBits, ChannelType, EmbedBuilder } = require('discord.js');
const tarkovAccessStore = require('../lib/tarkovAccessStore');
const { setMessageRoles, getMessageRoles, removeMessage, removeRoleEverywhere } = require('../lib/reactionRoleStore');
const { parseEmojiInput } = require('../lib/emoji');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('role')
    .setDescription('Add or remove a role from a member, create a self-service role, or manage who can use /tarkov')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles)
    .setDMPermission(false)
    .addSubcommand((sub) =>
      sub
        .setName('add')
        .setDescription('Add a role to a member')
        .addUserOption((opt) => opt.setName('user').setDescription('Member to update').setRequired(true))
        .addRoleOption((opt) => opt.setName('role').setDescription('Role to add').setRequired(true))
    )
    .addSubcommand((sub) =>
      sub
        .setName('remove')
        .setDescription('Remove a role from a member')
        .addUserOption((opt) => opt.setName('user').setDescription('Member to update').setRequired(true))
        .addRoleOption((opt) => opt.setName('role').setDescription('Role to remove').setRequired(true))
    )
    .addSubcommand((sub) =>
      sub
        .setName('create')
        .setDescription('Create a role plus a private text/voice channel pair only that role can access')
        .addStringOption((opt) => opt.setName('name').setDescription('Name for the role and channels').setRequired(true))
    )
    .addSubcommand((sub) =>
      sub
        .setName('emoji')
        .setDescription('Same as /role create, plus post a message granting the role to anyone who reacts')
        .addStringOption((opt) => opt.setName('name').setDescription('Name for the role and channels').setRequired(true))
        .addStringOption((opt) =>
          opt.setName('emoji').setDescription('Emoji to react with for the role (unicode or custom emoji)').setRequired(true)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName('emoji-add')
        .setDescription('Add a new or existing role to a message previously posted by /role emoji')
        .addStringOption((opt) => opt.setName('message_id').setDescription('ID of the existing role-emoji message').setRequired(true))
        .addStringOption((opt) =>
          opt.setName('emoji').setDescription('Emoji to react with for the role (unicode or custom emoji)').setRequired(true)
        )
        .addRoleOption((opt) =>
          opt.setName('role').setDescription('Use this existing role instead of creating a new one')
        )
        .addStringOption((opt) =>
          opt.setName('name').setDescription('Name for a new role and channels (ignored if "role" is set)')
        )
        .addChannelOption((opt) =>
          opt
            .setName('channel')
            .setDescription('Channel the message is in (defaults to this channel)')
            .addChannelTypes(ChannelType.GuildText)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName('emoji-remove')
        .setDescription("Remove a role's entry from a role-emoji message, without deleting the role")
        .addStringOption((opt) => opt.setName('message_id').setDescription('ID of the role-emoji message').setRequired(true))
        .addRoleOption((opt) => opt.setName('role').setDescription('Role to remove from the message').setRequired(true))
        .addChannelOption((opt) =>
          opt
            .setName('channel')
            .setDescription('Channel the message is in (defaults to this channel)')
            .addChannelTypes(ChannelType.GuildText)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName('delete')
        .setDescription('Permanently delete a role from the server')
        .addRoleOption((opt) => opt.setName('role').setDescription('Role to delete').setRequired(true))
    )
    .addSubcommandGroup((group) =>
      group
        .setName('tarkov-access')
        .setDescription('Grant or revoke access to /tarkov (Manage Roles members always have access)')
        .addSubcommand((sub) =>
          sub
            .setName('add')
            .setDescription('Grant a role and/or user access to /tarkov')
            .addRoleOption((opt) => opt.setName('role').setDescription('Role to grant access to'))
            .addUserOption((opt) => opt.setName('user').setDescription('User to grant access to'))
        )
        .addSubcommand((sub) =>
          sub
            .setName('remove')
            .setDescription("Revoke a role and/or user's access to /tarkov")
            .addRoleOption((opt) => opt.setName('role').setDescription('Role to revoke access from'))
            .addUserOption((opt) => opt.setName('user').setDescription('User to revoke access from'))
        )
        .addSubcommand((sub) => sub.setName('list').setDescription('List everyone granted /tarkov access'))
    ),

  async execute(interaction) {
    if (interaction.options.getSubcommandGroup(false) === 'tarkov-access') {
      await handleTarkovAccess(interaction);
      return;
    }

    const sub = interaction.options.getSubcommand();

    if (sub === 'create' || sub === 'emoji') {
      await handleCreate(interaction, sub);
      return;
    }

    if (sub === 'emoji-add') {
      await handleEmojiAdd(interaction);
      return;
    }

    if (sub === 'emoji-remove') {
      await handleEmojiRemove(interaction);
      return;
    }

    if (sub === 'delete') {
      await handleDeleteRole(interaction);
      return;
    }

    const targetUser = interaction.options.getUser('user', true);
    const role = interaction.options.getRole('role', true);

    const guild = interaction.guild;
    const member = await guild.members.fetch(targetUser.id).catch(() => null);
    if (!member) {
      await interaction.reply({ content: 'That user is not a member of this server.', ephemeral: true });
      return;
    }

    const botMember = await guild.members.fetchMe();
    if (role.position >= botMember.roles.highest.position) {
      await interaction.reply({
        content: `I can't manage **${role.name}** because it's positioned at or above my highest role. Move my role above it in Server Settings > Roles.`,
        ephemeral: true,
      });
      return;
    }

    try {
      if (sub === 'add') {
        await member.roles.add(role, `Added by ${interaction.user.tag} via /role add`);
        await interaction.reply({ content: `Added **${role.name}** to ${targetUser}.`, ephemeral: true });
      } else {
        await member.roles.remove(role, `Removed by ${interaction.user.tag} via /role remove`);
        await interaction.reply({ content: `Removed **${role.name}** from ${targetUser}.`, ephemeral: true });
      }
    } catch (error) {
      console.error('Failed to update member role:', error);
      await interaction.reply({ content: 'Failed to update that role. Check my permissions and role position.', ephemeral: true });
    }
  },
};

async function handleTarkovAccess(interaction) {
  const sub = interaction.options.getSubcommand();

  if (sub === 'list') {
    const { roleIds, userIds } = tarkovAccessStore.getAll();
    const roleMentions = roleIds.length ? roleIds.map((id) => `<@&${id}>`).join(', ') : 'None';
    const userMentions = userIds.length ? userIds.map((id) => `<@${id}>`).join(', ') : 'None';
    await interaction.reply({
      content: `**Roles granted /tarkov access:** ${roleMentions}\n**Users granted /tarkov access:** ${userMentions}\n\n(Anyone with Manage Roles permission always has access, regardless of this list.)`,
      ephemeral: true,
    });
    return;
  }

  const role = interaction.options.getRole('role');
  const user = interaction.options.getUser('user');
  if (!role && !user) {
    await interaction.reply({ content: 'Specify a role and/or a user to grant or revoke.', ephemeral: true });
    return;
  }

  const targets = [role ? `${role}` : null, user ? `${user}` : null].filter(Boolean).join(' and ');

  if (sub === 'add') {
    if (role) tarkovAccessStore.addRole(role.id);
    if (user) tarkovAccessStore.addUser(user.id);
    await interaction.reply({ content: `Granted /tarkov access to ${targets}.`, ephemeral: true });
    return;
  }

  if (role) tarkovAccessStore.removeRole(role.id);
  if (user) tarkovAccessStore.removeUser(user.id);
  await interaction.reply({ content: `Revoked /tarkov access from ${targets}.`, ephemeral: true });
}

// Discord requires GuildText channel names to be lowercase with only
// alphanumerics/hyphens/underscores; voice channel names have no such
// restriction, so only the text channel needs slugifying.
function slugify(name) {
  return name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 100) || 'role';
}

// Shared by /role create, /role emoji, and /role emoji-add. Replies (or
// defers, on success) itself; returns null after a failure it has already
// reported, or { role, textChannel, voiceChannel } on success.
async function createRoleWithChannels(interaction, name, sub) {
  const guild = interaction.guild;
  const botMember = await guild.members.fetchMe();
  if (!botMember.permissions.has(PermissionFlagsBits.ManageRoles) || !botMember.permissions.has(PermissionFlagsBits.ManageChannels)) {
    await interaction.reply({ content: "I need both **Manage Roles** and **Manage Channels** permissions to do that.", ephemeral: true });
    return null;
  }

  await interaction.deferReply({ ephemeral: true });

  let role;
  try {
    role = await guild.roles.create({
      name,
      permissions: [],
      reason: `Created by ${interaction.user.tag} via /role ${sub}`,
    });
  } catch (error) {
    console.error('Failed to create role:', error);
    await interaction.editReply("Couldn't create the role. Check my role position and permissions.");
    return null;
  }

  const overwrites = [
    { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
    { id: botMember.id, allow: [PermissionFlagsBits.ViewChannel] },
  ];

  let textChannel;
  let voiceChannel;
  try {
    textChannel = await guild.channels.create({
      name: slugify(name),
      type: ChannelType.GuildText,
      reason: `Created by ${interaction.user.tag} via /role ${sub}`,
      permissionOverwrites: [
        ...overwrites,
        { id: role.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
      ],
    });
    voiceChannel = await guild.channels.create({
      name,
      type: ChannelType.GuildVoice,
      reason: `Created by ${interaction.user.tag} via /role ${sub}`,
      permissionOverwrites: [
        ...overwrites,
        { id: role.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.Speak] },
      ],
    });
  } catch (error) {
    console.error('Failed to create role channels:', error);
    await role.delete('Rolled back: channel creation failed').catch(() => {});
    if (textChannel) await textChannel.delete('Rolled back: voice channel creation failed').catch(() => {});
    await interaction.editReply("Created the role, but couldn't create its channels, so I rolled the role back too. Check my permissions and try again.");
    return null;
  }

  return { role, textChannel, voiceChannel };
}

async function handleCreate(interaction, sub) {
  const name = interaction.options.getString('name', true).slice(0, 100);
  const emojiInput = sub === 'emoji' ? interaction.options.getString('emoji', true) : null;

  const created = await createRoleWithChannels(interaction, name, sub);
  if (!created) return;
  const { role, textChannel, voiceChannel } = created;

  if (sub === 'create') {
    await interaction.editReply(
      `Created ${role} with ${textChannel} and ${voiceChannel.name} — only members with that role can see either channel. Use \`/role add\` to grant it.`
    );
    return;
  }

  const embed = new EmbedBuilder()
    .setTitle(name)
    .setDescription(`React with ${emojiInput} to get the ${role} role.`)
    .setColor(0x5865f2);

  let message;
  try {
    message = await interaction.channel.send({ embeds: [embed] });
    await message.react(emojiInput);
  } catch (error) {
    console.error('Failed to post/react to role-emoji message:', error);
    await interaction.editReply(
      `Created ${role} with ${textChannel} and ${voiceChannel.name}, but couldn't post or react to the emoji message (${error.message}). Set one up manually with \`/reactionrole create\`.`
    );
    return;
  }

  setMessageRoles(message.id, message.channelId, { [parseEmojiInput(emojiInput)]: role.id });

  await interaction.editReply(
    `Created ${role} with ${textChannel} and ${voiceChannel.name}, and posted a message — react with ${emojiInput} there to get the role.`
  );
}

// Edits the message's embed to add a line for `role`/`emojiInput`, reacts
// with the emoji, and merges the mapping into the reaction-role store.
// Returns true on success; on failure, reports it via editReply and
// returns false.
async function appendRoleToMessage(interaction, message, role, emojiInput, line, failurePrefix = '') {
  const oldDescription = message.embeds[0].description || '';
  const embed = EmbedBuilder.from(message.embeds[0]).setDescription(`${oldDescription}\n${line}`.trim());

  try {
    await message.edit({ embeds: [embed] });
    await message.react(emojiInput);
  } catch (error) {
    console.error('Failed to update role-emoji message:', error);
    const sentence = `${failurePrefix ? 'c' : 'C'}ouldn't update the message (${error.message}). Add the reaction there manually.`;
    await interaction.editReply(`${failurePrefix}${sentence}`);
    return false;
  }

  setMessageRoles(message.id, message.channelId, { ...(getMessageRoles(message.id) || {}), [parseEmojiInput(emojiInput)]: role.id });
  return true;
}

async function handleEmojiAdd(interaction) {
  const messageId = interaction.options.getString('message_id', true);
  const emojiInput = interaction.options.getString('emoji', true);
  const existingRole = interaction.options.getRole('role');
  const name = interaction.options.getString('name');
  const channel = interaction.options.getChannel('channel') || interaction.channel;

  if (!existingRole && !name) {
    await interaction.reply({ content: 'Provide either an existing `role` to reuse, or a `name` to create a new one.', ephemeral: true });
    return;
  }

  // force: true - an unforced fetch can return a stale cached copy of the
  // message (e.g. from before the last /role emoji-add's edit landed),
  // and building the new embed off that would silently drop whatever line
  // was most recently added.
  const message = await channel.messages.fetch({ message: messageId, force: true }).catch(() => null);
  if (!message) {
    await interaction.reply({ content: `Couldn't find a message with ID \`${messageId}\` in ${channel}.`, ephemeral: true });
    return;
  }
  if (message.author.id !== interaction.client.user.id || message.embeds.length === 0) {
    await interaction.reply({
      content: "That message isn't one of mine with an embed - I can only add to a message posted by `/role emoji` (or `/role emoji-add`).",
      ephemeral: true,
    });
    return;
  }

  if (existingRole) {
    const botMember = await interaction.guild.members.fetchMe();
    if (existingRole.position >= botMember.roles.highest.position) {
      await interaction.reply({
        content: `I can't manage **${existingRole.name}** because it's positioned at or above my highest role. Move my role above it in Server Settings > Roles.`,
        ephemeral: true,
      });
      return;
    }

    await interaction.deferReply({ ephemeral: true });
    const line = `React with ${emojiInput} to get the ${existingRole} role.`;
    if (!(await appendRoleToMessage(interaction, message, existingRole, emojiInput, line))) return;

    await interaction.editReply(`Added ${existingRole} to the message — react with ${emojiInput} there to get it.`);
    return;
  }

  const created = await createRoleWithChannels(interaction, name.slice(0, 100), 'emoji-add');
  if (!created) return;
  const { role, textChannel, voiceChannel } = created;

  const line = `React with ${emojiInput} to get the ${role} role.`;
  const failurePrefix = `Created ${role} with ${textChannel} and ${voiceChannel.name}, but `;
  if (!(await appendRoleToMessage(interaction, message, role, emojiInput, line, failurePrefix))) return;

  await interaction.editReply(
    `Created ${role} with ${textChannel} and ${voiceChannel.name}, and added it to the message — react with ${emojiInput} there to get the role.`
  );
}

async function handleEmojiRemove(interaction) {
  const messageId = interaction.options.getString('message_id', true);
  const role = interaction.options.getRole('role', true);
  const channel = interaction.options.getChannel('channel') || interaction.channel;

  const message = await channel.messages.fetch({ message: messageId, force: true }).catch(() => null);
  if (!message) {
    await interaction.reply({ content: `Couldn't find a message with ID \`${messageId}\` in ${channel}.`, ephemeral: true });
    return;
  }

  const mapping = getMessageRoles(message.id);
  const entry = mapping && Object.entries(mapping).find(([, roleId]) => roleId === role.id);
  if (!entry) {
    await interaction.reply({ content: `${role} isn't on that message.`, ephemeral: true });
    return;
  }
  const [emojiStoreKey] = entry;

  await interaction.deferReply({ ephemeral: true });

  const remaining = { ...mapping };
  delete remaining[emojiStoreKey];
  if (Object.keys(remaining).length === 0) removeMessage(message.id);
  else setMessageRoles(message.id, message.channelId, remaining);

  if (message.embeds.length > 0) {
    const roleMention = `<@&${role.id}>`;
    const lines = (message.embeds[0].description || '').split('\n').filter((line) => !line.includes(roleMention));
    const embed = EmbedBuilder.from(message.embeds[0]).setDescription(lines.join('\n'));
    await message.edit({ embeds: [embed] }).catch((error) => console.error('Failed to update message after /role emoji-remove:', error));
  }

  const reaction = message.reactions.cache.get(emojiStoreKey);
  if (reaction) await reaction.remove().catch((error) => console.error('Failed to remove reaction after /role emoji-remove:', error));

  await interaction.editReply(`Removed ${role} from the message. The role itself is unaffected.`);
}

// A channel counts as "gated on" a role if @everyone is denied ViewChannel
// and the role is explicitly allowed it - exactly the overwrite pattern
// createRoleWithChannels() sets up. Must be gathered BEFORE the role is
// deleted: Discord strips a role's overwrites from every channel the
// moment it's gone, so there'd be nothing left to match afterward.
function findChannelsGatedOnRole(guild, roleId) {
  const everyoneId = guild.roles.everyone.id;
  return guild.channels.cache.filter((channel) => {
    if (!channel.permissionOverwrites) return false;
    const everyoneOverwrite = channel.permissionOverwrites.cache.get(everyoneId);
    const roleOverwrite = channel.permissionOverwrites.cache.get(roleId);
    if (!everyoneOverwrite || !roleOverwrite) return false;
    return everyoneOverwrite.deny.has(PermissionFlagsBits.ViewChannel) && roleOverwrite.allow.has(PermissionFlagsBits.ViewChannel);
  });
}

// Strips the line mentioning `role` out of a tracked message's embed and
// removes the bot's reaction for it. Best-effort: logs and moves on if the
// channel/message/edit fails (e.g. already deleted, or it's a pre-upgrade
// entry with no stored channelId), since the role is already gone either way.
async function stripRoleFromMessage(client, role, { messageId, channelId, emojiKey }) {
  if (!channelId) return false;

  try {
    const channel = await client.channels.fetch(channelId);
    const message = await channel.messages.fetch({ message: messageId, force: true });
    if (message.embeds.length > 0) {
      const roleMention = `<@&${role.id}>`;
      const lines = (message.embeds[0].description || '').split('\n').filter((line) => !line.includes(roleMention));
      const embed = EmbedBuilder.from(message.embeds[0]).setDescription(lines.join('\n'));
      await message.edit({ embeds: [embed] });
    }
    const reaction = message.reactions.cache.get(emojiKey);
    if (reaction) await reaction.remove().catch(() => {});
    return true;
  } catch (error) {
    console.error(`Failed to strip deleted role from message ${messageId}:`, error);
    return false;
  }
}

async function handleDeleteRole(interaction) {
  const role = interaction.options.getRole('role', true);
  const guild = interaction.guild;
  const botMember = await guild.members.fetchMe();

  if (role.position >= botMember.roles.highest.position) {
    await interaction.reply({
      content: `I can't manage **${role.name}** because it's positioned at or above my highest role. Move my role above it in Server Settings > Roles.`,
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  const gatedChannels = [...findChannelsGatedOnRole(guild, role.id).values()];

  const roleName = role.name;
  try {
    await role.delete(`Deleted by ${interaction.user.tag} via /role delete`);
  } catch (error) {
    console.error('Failed to delete role:', error);
    await interaction.editReply("Couldn't delete that role. Check my permissions and role position.");
    return;
  }

  let deletedChannels = 0;
  for (const channel of gatedChannels) {
    try {
      await channel.delete(`Role "${roleName}" deleted via /role delete`);
      deletedChannels++;
    } catch (error) {
      console.error(`Failed to delete channel ${channel.id} after role delete:`, error);
    }
  }

  const affected = removeRoleEverywhere(role.id);
  let editedMessages = 0;
  for (const entry of affected) {
    if (await stripRoleFromMessage(interaction.client, role, entry)) editedMessages++;
  }

  const parts = [`Deleted the **${roleName}** role.`];
  if (gatedChannels.length > 0) parts.push(`Deleted ${deletedChannels}/${gatedChannels.length} channel(s) gated on it.`);
  if (affected.length > 0) parts.push(`Removed it from ${editedMessages}/${affected.length} reaction-role message(s).`);

  await interaction.editReply(parts.join(' '));
}
