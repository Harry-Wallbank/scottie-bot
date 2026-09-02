const { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder, ChannelType } = require('discord.js');
const { setMessageRoles, removeMessage } = require('../lib/reactionRoleStore');
const { parseEmojiInput } = require('../lib/emoji');

const MAX_PAIRS = 5;

function buildCommand() {
  const builder = new SlashCommandBuilder()
    .setName('reactionrole')
    .setDescription('Set up a message where reacting grants a role')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles)
    .setDMPermission(false);

  builder.addSubcommand((sub) => {
    sub
      .setName('create')
      .setDescription('Post a new reaction-role message')
      .addStringOption((opt) => opt.setName('title').setDescription('Embed title').setRequired(true))
      .addStringOption((opt) => opt.setName('emoji1').setDescription('Emoji 1 (unicode emoji or custom emoji)').setRequired(true))
      .addRoleOption((opt) => opt.setName('role1').setDescription('Role granted for emoji 1').setRequired(true));

    // Required options (title, emoji1, role1) must come before any optional
    // ones, or Discord rejects the command registration.
    sub.addChannelOption((opt) =>
      opt
        .setName('channel')
        .setDescription('Channel to post in (defaults to this channel)')
        .addChannelTypes(ChannelType.GuildText)
    );

    for (let i = 2; i <= MAX_PAIRS; i++) {
      sub.addStringOption((opt) =>
        opt.setName(`emoji${i}`).setDescription(`Emoji ${i} (unicode emoji or custom emoji)`)
      );
      sub.addRoleOption((opt) => opt.setName(`role${i}`).setDescription(`Role granted for emoji ${i}`));
    }
    return sub;
  });

  builder.addSubcommand((sub) =>
    sub
      .setName('delete')
      .setDescription('Stop treating a message as a reaction-role message')
      .addStringOption((opt) => opt.setName('message_id').setDescription('ID of the reaction-role message').setRequired(true))
  );

  return builder;
}

module.exports = {
  data: buildCommand(),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();

    if (sub === 'delete') {
      const messageId = interaction.options.getString('message_id', true);
      removeMessage(messageId);
      await interaction.reply({ content: `Message \`${messageId}\` is no longer a reaction-role message.`, ephemeral: true });
      return;
    }

    const title = interaction.options.getString('title', true);
    const channel = interaction.options.getChannel('channel') || interaction.channel;

    const pairs = [];
    for (let i = 1; i <= MAX_PAIRS; i++) {
      const emojiInput = interaction.options.getString(`emoji${i}`);
      const role = interaction.options.getRole(`role${i}`);
      if (!emojiInput || !role) continue;
      pairs.push({ emojiInput, role });
    }

    if (pairs.length === 0) {
      await interaction.reply({ content: 'You must provide at least one emoji/role pair.', ephemeral: true });
      return;
    }

    const botMember = await interaction.guild.members.fetchMe();
    const unmanageable = pairs.find((p) => p.role.position >= botMember.roles.highest.position);
    if (unmanageable) {
      await interaction.reply({
        content: `I can't manage **${unmanageable.role.name}** because it's positioned at or above my highest role.`,
        ephemeral: true,
      });
      return;
    }

    const embed = new EmbedBuilder()
      .setTitle(title)
      .setDescription(pairs.map((p) => `${p.emojiInput} — ${p.role}`).join('\n'))
      .setColor(0x5865f2);

    let message;
    try {
      message = await channel.send({ embeds: [embed] });
    } catch (error) {
      console.error('Failed to post reaction-role message:', error);
      await interaction.reply({ content: `I couldn't send a message in ${channel}. Check my permissions there.`, ephemeral: true });
      return;
    }

    const mapping = {};
    const failedEmoji = [];
    for (const p of pairs) {
      try {
        await message.react(p.emojiInput);
        mapping[parseEmojiInput(p.emojiInput)] = p.role.id;
      } catch (error) {
        console.error(`Failed to react with ${p.emojiInput}:`, error);
        failedEmoji.push(p.emojiInput);
      }
    }

    setMessageRoles(message.id, channel.id, mapping);

    const summary =
      failedEmoji.length > 0
        ? `Reaction-role message posted in ${channel}, but I couldn't react with: ${failedEmoji.join(', ')}. Those emoji were left out of the mapping — delete and recreate once fixed.`
        : `Reaction-role message posted in ${channel}.`;

    await interaction.reply({ content: summary, ephemeral: true });
  },
};
