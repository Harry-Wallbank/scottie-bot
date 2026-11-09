const { SlashCommandBuilder, PermissionFlagsBits, ChannelType, EmbedBuilder } = require('discord.js');
const tarkovAccessStore = require('../lib/tarkovAccessStore');
const { setMessageRoles, getMessageRoles, getMessageChannelId, removeMessage, removeRoleEverywhere } = require('../lib/reactionRoleStore');
const { parseEmojiInput } = require('../lib/emoji');

const { REACTION_ROLE_HEADER } = require('../lib/reactionRoleText');

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
  } else {
    if (role) tarkovAccessStore.removeRole(role.id);
    if (user) tarkovAccessStore.removeUser(user.id);
    await interaction.reply({ content: `Revoked /tarkov access from ${targets}.`, ephemeral: true });
  }
}

async function createRoleAndChannels(guild, name) {
  const role = await guild.roles.create({
    name: name,
    reason: 'Created via /role',
  });

  const category = await guild.channels.create({
    name: name,
    type: ChannelType.GuildCategory,
    permissionOverwrites: [
      {
        id: guild.roles.everyone.id,
        deny: [PermissionFlagsBits.ViewChannel],
      },
      {
        id: role.id,
        allow: [PermissionFlagsBits.ViewChannel],
      },
    ],
  });

  await guild.channels.create({
    name: name.toLowerCase().replace(/\s+/g, '-'),
    type: ChannelType.GuildText,
    parent: category.id,
  });

  await guild.channels.create({
    name: `${name} Voice`,
    type: ChannelType.GuildVoice,
    parent: category.id,
  });

  return { role, category };
}

async function handleCreate(interaction, sub) {
  const name = interaction.options.getString('name', true);
  const guild = interaction.guild;

  if (sub === 'create') {
    const created = await createRoleAndChannels(guild, name);
    await interaction.reply({
      content: `Created role **${created.role.name}** and private channels.`,
      ephemeral: true,
    });
    return;
  }

  const emojiInput = interaction.options.getString('emoji', true);
  const created = await createRoleAndChannels(guild, name);
  const role = created.role;

  const botMember = await guild.members.fetchMe();
  if (role.position >= botMember.roles.highest.position) {
    await interaction.reply({
      content: `Created role **${role.name}**, but I cannot manage it because it is above my highest role.`,
      ephemeral: true,
    });
    return;
  }

  const line = `${REACTION_ROLE_HEADER}\n${emojiInput} - ${role}`;
  const embed = new EmbedBuilder()
    .setTitle(`Role: ${role.name}`)
    .setDescription(line)
    .setColor(0x5865f2);

  const message = await interaction.channel.send({ embeds: [embed] });

  const emojiKeyStr = parseEmojiInput(emojiInput);
  try {
    await message.react(emojiInput);
  } catch (error) {
    console.error(`Failed to react with ${emojiInput}:`, error);
  }

  setMessageRoles(message.id, interaction.channel.id, { [emojiKeyStr]: role.id });

  await interaction.reply({
    content: `Created role **${role.name}**, private channels, and posted reaction-role message in ${interaction.channel}.`,
    ephemeral: true,
  });
}

async function handleEmojiAdd(interaction) {
  const messageId = interaction.options.getString('message_id', true);
  const emojiInput = interaction.options.getString('emoji', true);
  const roleOption = interaction.options.getRole('role');
  const nameOption = interaction.options.getString('name');
  const channelOption = interaction.options.getChannel('channel') || interaction.channel;

  if (!roleOption && !nameOption) {
    await interaction.reply({
      content: 'You must specify either an existing `role` or a `name` for a new role.',
      ephemeral: true,
    });
    return;
  }

  const guild = interaction.guild;
  let targetChannel = channelOption;

  let targetMessage;
  try {
    targetMessage = await targetChannel.messages.fetch(messageId);
  } catch (error) {
    const storedChannelId = getMessageChannelId(messageId);
    if (storedChannelId && storedChannelId !== targetChannel.id) {
      const fetchedChannel = await guild.channels.fetch(storedChannelId).catch(() => null);
      if (fetchedChannel) {
        targetChannel = fetchedChannel;
        targetMessage = await targetChannel.messages.fetch(messageId).catch(() => null);
      }
    }
  }

  if (!targetMessage) {
    await interaction.reply({
      content: `Could not find message \`${messageId}\` in ${targetChannel}. Make sure the message ID and channel are correct.`,
      ephemeral: true,
    });
    return;
  }

  let role = roleOption;
  let createdChannelsNote = '';

  if (!role) {
    const created = await createRoleAndChannels(guild, nameOption);
    role = created.role;
    createdChannelsNote = ` Created new role **${role.name}** and channel category.`;
  }

  const botMember = await guild.members.fetchMe();
  if (role.position >= botMember.roles.highest.position) {
    await interaction.reply({
      content: `I can't manage **${role.name}** because it's positioned at or above my highest role.`,
      ephemeral: true,
    });
    return;
  }

  const newLine = `${emojiInput} - ${role}`;

  let embed = targetMessage.embeds[0] ? EmbedBuilder.from(targetMessage.embeds[0]) : new EmbedBuilder().setColor(0x5865f2);
  let lines = embed.data.description ? embed.data.description.split('\n').filter(Boolean) : [];

  let found = false;
  lines = lines.map((line) => {
    if (line.includes(`<@&${role.id}>`) || line.startsWith(emojiInput)) {
      found = true;
      return newLine;
    }
    const match = line.match(/^(\S+)\s*(?:—|-)\s*(<@&\d+>)(?:\s*(?:—|-)\s*".*")?/);
    if (match) {
      return `${match[1]} - ${match[2]}`;
    }
    return line;
  });

  if (!found) {
    lines.push(newLine);
  }

  embed.setDescription(lines.join('\n'));

  try {
    await targetMessage.edit({ embeds: [embed] });
  } catch (error) {
    console.error('Failed to edit reaction-role message:', error);
    await interaction.reply({
      content: 'Failed to update the message embed. Check my permissions.',
      ephemeral: true,
    });
    return;
  }

  const emojiKeyStr = parseEmojiInput(emojiInput);
  try {
    await targetMessage.react(emojiInput);
  } catch (error) {
    console.error(`Failed to react with ${emojiInput}:`, error);
  }

  const existingRoles = getMessageRoles(messageId) || {};
  existingRoles[emojiKeyStr] = role.id;
  setMessageRoles(messageId, targetChannel.id, existingRoles);

  await interaction.reply({
    content: `Added ${emojiInput} for **${role.name}** to message \`${messageId}\` in ${targetChannel}.${createdChannelsNote}`,
    ephemeral: true,
  });
}

async function handleEmojiRemove(interaction) {
  const messageId = interaction.options.getString('message_id', true);
  const role = interaction.options.getRole('role', true);
  const channelOption = interaction.options.getChannel('channel') || interaction.channel;
  const guild = interaction.guild;

  let targetChannel = channelOption;
  let targetMessage;
  try {
    targetMessage = await targetChannel.messages.fetch(messageId);
  } catch (error) {
    const storedChannelId = getMessageChannelId(messageId);
    if (storedChannelId && storedChannelId !== targetChannel.id) {
      const fetchedChannel = await guild.channels.fetch(storedChannelId).catch(() => null);
      if (fetchedChannel) {
        targetChannel = fetchedChannel;
        targetMessage = await targetChannel.messages.fetch(messageId).catch(() => null);
      }
    }
  }

  if (!targetMessage) {
    await interaction.reply({
      content: `Could not find message \`${messageId}\` in ${targetChannel}.`,
      ephemeral: true,
    });
    return;
  }

  const existingRoles = getMessageRoles(messageId) || {};
  const emojiKeyToRemove = Object.keys(existingRoles).find((key) => existingRoles[key] === role.id);

  if (emojiKeyToRemove) {
    delete existingRoles[emojiKeyToRemove];
    setMessageRoles(messageId, targetChannel.id, existingRoles);
  }

  if (targetMessage.embeds[0]) {
    const embed = EmbedBuilder.from(targetMessage.embeds[0]);
    if (embed.data.description) {
      const lines = embed.data.description
        .split('\n')
        .filter((line) => !line.includes(`<@&${role.id}>`));
      embed.setDescription(lines.join('\n'));
      await targetMessage.edit({ embeds: [embed] }).catch(() => null);
    }
  }

  await interaction.reply({
    content: `Removed **${role.name}** from message \`${messageId}\`.`,
    ephemeral: true,
  });
}

async function handleDeleteRole(interaction) {
  const role = interaction.options.getRole('role', true);
  const guild = interaction.guild;

  const botMember = await guild.members.fetchMe();
  if (role.position >= botMember.roles.highest.position) {
    await interaction.reply({
      content: `I can't delete **${role.name}** because it's positioned at or above my highest role.`,
      ephemeral: true,
    });
    return;
  }

  const affectedMessages = removeRoleEverywhere(role.id);

  for (const item of affectedMessages) {
    if (!item.channelId) continue;
    try {
      const channel = await guild.channels.fetch(item.channelId);
      if (channel && channel.isTextBased()) {
        const msg = await channel.messages.fetch(item.messageId);
        if (msg && msg.embeds[0]) {
          const embed = EmbedBuilder.from(msg.embeds[0]);
          if (embed.data.description) {
            const lines = embed.data.description
              .split('\n')
              .filter((line) => !line.includes(`<@&${role.id}>`));
            embed.setDescription(lines.join('\n'));
            await msg.edit({ embeds: [embed] });
          }
        }
      }
    } catch (err) {
      console.error(`Failed to update message ${item.messageId} after role deletion:`, err);
    }
  }

  const roleName = role.name;
  try {
    await role.delete(`Deleted by ${interaction.user.tag} via /role delete`);
  } catch (error) {
    console.error('Failed to delete role:', error);
    await interaction.reply({ content: `Failed to delete role **${roleName}**.`, ephemeral: true });
    return;
  }

  await interaction.reply({ content: `Deleted role **${roleName}**.`, ephemeral: true });
}
