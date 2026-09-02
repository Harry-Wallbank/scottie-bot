const { SlashCommandBuilder, PermissionFlagsBits, ChannelType, EmbedBuilder } = require('discord.js');
const tarkovAccessStore = require('../lib/tarkovAccessStore');
const { setMessageRoles } = require('../lib/reactionRoleStore');
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

async function handleCreate(interaction, sub) {
  const name = interaction.options.getString('name', true).slice(0, 100);
  const emojiInput = sub === 'emoji' ? interaction.options.getString('emoji', true) : null;

  const guild = interaction.guild;
  const botMember = await guild.members.fetchMe();
  if (!botMember.permissions.has(PermissionFlagsBits.ManageRoles) || !botMember.permissions.has(PermissionFlagsBits.ManageChannels)) {
    await interaction.reply({ content: "I need both **Manage Roles** and **Manage Channels** permissions to do that.", ephemeral: true });
    return;
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
    return;
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
    return;
  }

  if (sub === 'create') {
    await interaction.editReply(
      `Created ${role} with ${textChannel} and ${voiceChannel.name} — only members with that role can see either channel. Use \`/role add\` to grant it.`
    );
    return;
  }

  const embed = new EmbedBuilder()
    .setTitle(name)
    .setDescription(`React with ${emojiInput} to get the ${role} role and access to ${textChannel} and **${voiceChannel.name}**.`)
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

  setMessageRoles(message.id, { [parseEmojiInput(emojiInput)]: role.id });

  await interaction.editReply(
    `Created ${role} with ${textChannel} and ${voiceChannel.name}, and posted a message — react with ${emojiInput} there to get the role.`
  );
}
