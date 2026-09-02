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

function setMessageRoles(messageId, emojiToRoleId) {
  const data = load();
  data[messageId] = emojiToRoleId;
  save(data);
}

function getMessageRoles(messageId) {
  const data = load();
  return data[messageId] || null;
}

function removeMessage(messageId) {
  const data = load();
  delete data[messageId];
  save(data);
}

// Strips a role out of every message mapping that references it (e.g. when
// the role itself gets deleted). Returns the list of affected message IDs.
function removeRoleEverywhere(roleId) {
  const data = load();
  const affected = [];

  for (const [messageId, mapping] of Object.entries(data)) {
    const emojiKey = Object.keys(mapping).find((key) => mapping[key] === roleId);
    if (!emojiKey) continue;

    affected.push(messageId);
    delete mapping[emojiKey];
    if (Object.keys(mapping).length === 0) delete data[messageId];
  }

  if (affected.length > 0) save(data);
  return affected;
}

module.exports = { setMessageRoles, getMessageRoles, removeMessage, removeRoleEverywhere };
