const fs = require('node:fs');
const path = require('node:path');

const dataDir = path.join(__dirname, '..', 'data');
const storePath = path.join(dataDir, 'reactionRoles.json');

function load() {
  if (!fs.existsSync(storePath)) return {};
  try {
    return JSON.parse(fs.readFileSync(storePath, 'utf8'));
  } catch (error) {
    console.error('Failed to read reactionRoles.json, starting fresh:', error);
    return {};
  }
}

function save(data) {
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(storePath, JSON.stringify(data, null, 2));
}

// Entries used to be stored as a bare { emojiKey: roleId } map. Now they
// carry the channelId too (needed to find and edit the real message later,
// e.g. when a role backing an entry gets deleted), as { channelId, roles }.
// Normalize old-format entries on read so pre-existing data keeps working,
// just without a channelId (callers treat that as "can't locate the
// message to edit it").
function normalizeEntry(raw) {
  if (raw && typeof raw === 'object' && 'roles' in raw) return raw;
  return { channelId: null, roles: raw || {} };
}

function setMessageRoles(messageId, channelId, emojiToRoleId) {
  const data = load();
  data[messageId] = { channelId, roles: emojiToRoleId };
  save(data);
}

function getMessageRoles(messageId) {
  const data = load();
  if (!(messageId in data)) return null;
  return normalizeEntry(data[messageId]).roles;
}

function getMessageChannelId(messageId) {
  const data = load();
  if (!(messageId in data)) return null;
  return normalizeEntry(data[messageId]).channelId;
}

function removeMessage(messageId) {
  const data = load();
  delete data[messageId];
  save(data);
}

// Strips a role out of every message mapping that references it (e.g. when
// the role itself gets deleted). Returns { messageId, channelId, emojiKey }
// for each affected message so the caller can also edit the real message
// and remove the stale reaction.
function removeRoleEverywhere(roleId) {
  const data = load();
  const affected = [];

  for (const [messageId, raw] of Object.entries(data)) {
    const entry = normalizeEntry(raw);
    const emojiKey = Object.keys(entry.roles).find((key) => entry.roles[key] === roleId);
    if (!emojiKey) continue;

    affected.push({ messageId, channelId: entry.channelId, emojiKey });
    delete entry.roles[emojiKey];
    if (Object.keys(entry.roles).length === 0) delete data[messageId];
    else data[messageId] = entry;
  }

  if (affected.length > 0) save(data);
  return affected;
}

module.exports = { setMessageRoles, getMessageRoles, getMessageChannelId, removeMessage, removeRoleEverywhere };
