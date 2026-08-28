// Lets the bot owner DM the bot to create or tweak slash commands in real
// time. Gemini drafts a full replacement file for something in
// src/commands/, the owner reviews it and replies yes/no, and only on "yes"
// is it written, hot-reloaded into the running client, redeployed to
// Discord, and committed + pushed to GitHub.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { GoogleGenerativeAI, SchemaType } = require('@google/generative-ai');
const config = require('../config');
const { registerCommands } = require('../deploy-commands');

const REPO_ROOT = path.join(__dirname, '..', '..');
const COMMANDS_DIR = path.join(__dirname, '..', 'commands');
const LIB_DIR = path.join(__dirname, '..', 'lib');

const SYSTEM_PROMPT = `You are the maintenance agent for a Discord bot built with discord.js v14 (Node.js, CommonJS).
You help the bot's owner create new slash commands or tweak existing ones in src/commands/, entirely through this DM conversation.

Conventions to follow (mirror existing commands — use list_commands and read_file to check before writing anything):
- Each file in src/commands/ exports { data: <SlashCommandBuilder instance>, execute(interaction) { ... } }, and optionally autocomplete/modalSubmit/buttonClick handlers following the same pattern as existing commands.
- Reuse helpers under src/lib/ where relevant instead of duplicating logic.
- Reply ephemeral for anything not meant for the whole channel, matching the style of similar existing commands.
- Keep changes minimal and scoped to exactly what was asked.

Read enough existing code with list_commands/read_file to be confident before proposing anything. When the request is ambiguous, ask a clarifying question in plain text instead of guessing.

When you're ready to make a concrete, complete change, call propose_change with the FULL new file content (never a diff or partial snippet) and a short plain-English explanation. The owner will see your explanation plus the full file and reply yes/no — nothing is written until they confirm.`;

const toolDeclarations = [
  {
    name: 'list_commands',
    description: 'List the .js files currently in src/commands/.',
    parameters: { type: SchemaType.OBJECT, properties: {} },
  },
  {
    name: 'read_file',
    description: 'Read a file. Path must be relative to the repo root, under src/commands/ or src/lib/.',
    parameters: {
      type: SchemaType.OBJECT,
      properties: { path: { type: SchemaType.STRING, description: 'e.g. "src/commands/role.js"' } },
      required: ['path'],
    },
  },
  {
    name: 'propose_change',
    description:
      'Propose creating or overwriting a command file. This does NOT apply the change - it is shown to the owner for a yes/no confirmation first.',
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        filename: { type: SchemaType.STRING, description: 'Bare filename only, e.g. "ping.js" - no path segments.' },
        content: { type: SchemaType.STRING, description: 'Full new file content.' },
        explanation: { type: SchemaType.STRING, description: 'Short plain-English summary of what changed and why.' },
      },
      required: ['filename', 'content', 'explanation'],
    },
  },
];

const genAI = config.geminiApiKey ? new GoogleGenerativeAI(config.geminiApiKey) : null;
const model = genAI
  ? genAI.getGenerativeModel({
      model: 'gemini-3.6-flash',
      systemInstruction: SYSTEM_PROMPT,
      tools: [{ functionDeclarations: toolDeclarations }],
    })
  : null;

// channelId -> { history: Content[], pending: object|null }
const sessions = new Map();

function safeCommandsPath(filename) {
  if (typeof filename !== 'string' || !/^[a-zA-Z0-9_-]+\.js$/.test(filename)) {
    throw new Error('Invalid filename - must be a bare .js filename with no path segments.');
  }
  return path.join(COMMANDS_DIR, filename);
}

function safeReadPath(relPath) {
  const resolved = path.resolve(REPO_ROOT, String(relPath));
  const allowedRoots = [COMMANDS_DIR, LIB_DIR];
  if (!allowedRoots.some((root) => resolved === root || resolved.startsWith(root + path.sep))) {
    throw new Error('Can only read files under src/commands/ or src/lib/.');
  }
  return resolved;
}

function runTool(name, args) {
  if (name === 'list_commands') {
    return fs.readdirSync(COMMANDS_DIR).filter((f) => f.endsWith('.js')).join('\n');
  }
  if (name === 'read_file') {
    const resolved = safeReadPath(args.path);
    if (!fs.existsSync(resolved)) return `File not found: ${args.path}`;
    return fs.readFileSync(resolved, 'utf8');
  }
  throw new Error(`Unknown tool: ${name}`);
}

async function sendChunked(channel, content) {
  const MAX = 1900;
  for (let i = 0; i < content.length; i += MAX) {
    await channel.send('```js\n' + content.slice(i, i + MAX) + '\n```');
  }
}

async function handleDm(message) {
  if (!model) {
    await message.reply('The DM command agent is not configured (missing `GEMINI_API_KEY` on the server).');
    return;
  }

  const text = message.content.trim();
  if (!text) return;

  const channelId = message.channel.id;
  let session = sessions.get(channelId);
  if (!session) {
    session = { history: [], pending: null };
    sessions.set(channelId, session);
  }

  if (session.pending) {
    const lc = text.toLowerCase();
    if (['yes', 'y', 'confirm'].includes(lc)) {
      await applyPending(message, session);
      return;
    }
    if (['no', 'n', 'cancel'].includes(lc)) {
      session.history.push({ role: 'user', parts: [{ text: 'The owner declined the proposed change. Nothing was written.' }] });
      session.pending = null;
      await message.reply('Cancelled - nothing was changed.');
      return;
    }
    await message.reply(
      'There is a pending change awaiting confirmation - reply "yes" to apply it or "no" to cancel it before sending a new request.'
    );
    return;
  }

  session.history.push({ role: 'user', parts: [{ text }] });

  try {
    await message.channel.sendTyping().catch(() => {});
    await runAgentTurn(message, session);
  } catch (error) {
    console.error('DM agent error:', error);
    await message.reply(`Something went wrong talking to Gemini: ${error.message}`);
  }
}

async function generateWithRetry(request) {
  const delays = [1000, 3000, 7000];
  for (let attempt = 0; ; attempt++) {
    try {
      return await model.generateContent(request);
    } catch (error) {
      const retryable = error.status === 503 || error.status === 429;
      if (!retryable || attempt >= delays.length) throw error;
      await new Promise((resolve) => setTimeout(resolve, delays[attempt]));
    }
  }
}

async function runAgentTurn(message, session) {
  for (let step = 0; step < 8; step++) {
    const result = await generateWithRetry({ contents: session.history });
    const candidate = result.response.candidates?.[0];
    const parts = candidate?.content?.parts || [];

    session.history.push({ role: 'model', parts });

    const functionCalls = parts.filter((p) => p.functionCall).map((p) => p.functionCall);
    const proposal = functionCalls.find((fc) => fc.name === 'propose_change');

    if (proposal) {
      await presentProposal(message, session, proposal);
      return;
    }

    if (functionCalls.length === 0) {
      const reply = parts
        .filter((p) => p.text)
        .map((p) => p.text)
        .join('\n')
        .trim();
      await message.reply(reply || '(no response)');
      return;
    }

    const responseParts = functionCalls.map((fc) => {
      let content;
      try {
        content = String(runTool(fc.name, fc.args || {})).slice(0, 8000);
      } catch (error) {
        content = `Error: ${error.message}`;
      }
      return { functionResponse: { name: fc.name, response: { content } } };
    });
    session.history.push({ role: 'user', parts: responseParts });
  }

  await message.reply('Stopped after too many steps without reaching a proposal - try rephrasing your request.');
}

async function presentProposal(message, session, proposal) {
  const { filename, content, explanation } = proposal.args || {};

  let destPath;
  try {
    destPath = safeCommandsPath(filename);
  } catch (error) {
    session.history.push({
      role: 'user',
      parts: [{ functionResponse: { name: proposal.name, response: { content: `Error: ${error.message}` } } }],
    });
    await message.reply(`Gemini proposed an invalid filename (${filename}): ${error.message}`);
    return;
  }

  const exists = fs.existsSync(destPath);
  const oldContent = exists ? fs.readFileSync(destPath, 'utf8') : null;

  session.pending = { filename, destPath, content, oldContent };
  session.history.push({
    role: 'user',
    parts: [
      {
        functionResponse: {
          name: proposal.name,
          response: { content: 'Presented to the owner; awaiting yes/no confirmation.' },
        },
      },
    ],
  });

  await message.reply(
    `**${exists ? 'Editing' : 'Creating'} \`src/commands/${filename}\`**\n${explanation}\n\nReply **yes** to apply and reload it live, or **no** to cancel.`
  );
  await sendChunked(message.channel, content);
}

async function applyPending(message, session) {
  const { destPath, content, oldContent, filename } = session.pending;
  session.pending = null;

  fs.writeFileSync(destPath, content, 'utf8');

  let command;
  try {
    delete require.cache[require.resolve(destPath)];
    command = require(destPath);
    if (!command || !command.data || typeof command.execute !== 'function') {
      throw new Error('File must export { data, execute }.');
    }
  } catch (error) {
    if (oldContent === null) {
      fs.unlinkSync(destPath);
    } else {
      fs.writeFileSync(destPath, oldContent, 'utf8');
      delete require.cache[require.resolve(destPath)];
    }
    session.history.push({
      role: 'user',
      parts: [{ text: `The owner confirmed, but loading the new file failed and it was reverted: ${error.message}` }],
    });
    await message.reply(`Failed to load the new command, reverted the file: ${error.message}`);
    return;
  }

  message.client.commands.set(command.data.name, command);

  let noteParts = [];
  try {
    await registerCommands();
  } catch (error) {
    noteParts.push(`registering it with Discord failed (${error.message}) - it'll retry on the next manual deploy`);
  }

  try {
    commitAndPush(filename, oldContent === null ? 'Add' : 'Update');
    noteParts.push('committed and pushed to GitHub');
  } catch (error) {
    noteParts.push(`commit/push to GitHub failed (${error.message})`);
  }

  const note = noteParts.length ? ` (${noteParts.join('; ')})` : '';
  session.history.push({
    role: 'user',
    parts: [{ text: `The owner confirmed. The change was applied and hot-reloaded${note}.` }],
  });
  await message.reply(`Done - \`${filename}\` is live${note}.`);
}

function commitAndPush(filename, verb) {
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 'Tarkov Bot DM Agent',
    GIT_AUTHOR_EMAIL: 'bot@tarkov-bot.local',
    GIT_COMMITTER_NAME: 'Tarkov Bot DM Agent',
    GIT_COMMITTER_EMAIL: 'bot@tarkov-bot.local',
  };
  const relPath = path.join('src', 'commands', filename);
  execFileSync('git', ['add', relPath], { cwd: REPO_ROOT, env });
  execFileSync('git', ['commit', '-m', `${verb} /${path.basename(filename, '.js')} via DM agent`], {
    cwd: REPO_ROOT,
    env,
  });
  execFileSync('git', ['push', 'origin', 'HEAD'], { cwd: REPO_ROOT, env });
}

module.exports = { handleDm };
