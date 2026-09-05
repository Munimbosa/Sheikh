const fs = require('fs');
const path = require('path');
const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const { GoalFollow, GoalNear } = goals;

let pvpPlugin = null;
try {
  pvpPlugin = require('mineflayer-pvp').plugin;
} catch (e) {
  // mineflayer-pvp not installed — combat command will just say so
}

// =============================================================================
// CONFIG
// mcbot.json lives in the same folder as this file. If it doesn't exist yet,
// it's created automatically the first time this file loads. After that,
// edit mcbot.json directly — no code changes needed for server/account/admin
// changes (run "mcbot reload" after editing it while the bot is running).
// =============================================================================
const CONFIG_PATH = path.join(__dirname, 'mcbot.json');

const DEFAULT_CONFIG = {
  groupTID: '27720992177492239',
  adminIds: ['100077553281922', '100042061672382'],
  botAccount: {
    username: 'sahara48',
    password: '',
    auth: 'offline'
  },
  server: {
    host: 'shekcarsmpv4.aternos.me',
    port: 54909,
    version: '1.21.4'
  },
  features: {
    autoAuth: {
      enabled: true,
      password: 'shekertaboro2'
    },
    antiAFK: {
      enabled: true,
      mode: 'wander'
    },
    autoReconnect: true,
    maxReconnectAttempts: 5,
    reconnectDelayMs: 10000
  }
};

function loadConfig() {
  try {
    if (!fs.existsSync(CONFIG_PATH)) {
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2), 'utf8');
      console.log(`[mcbot] mcbot.json not found — created a default one at ${CONFIG_PATH}`);
      return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
    }

    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    const parsed = JSON.parse(raw);

    return {
      groupTID: parsed.groupTID || DEFAULT_CONFIG.groupTID,
      adminIds: Array.isArray(parsed.adminIds) ? parsed.adminIds : DEFAULT_CONFIG.adminIds,
      botAccount: Object.assign({}, DEFAULT_CONFIG.botAccount, parsed.botAccount),
      server: Object.assign({}, DEFAULT_CONFIG.server, parsed.server),
      features: {
        autoAuth: Object.assign({}, DEFAULT_CONFIG.features.autoAuth, parsed.features && parsed.features.autoAuth),
        antiAFK: Object.assign({}, DEFAULT_CONFIG.features.antiAFK, parsed.features && parsed.features.antiAFK),
        autoReconnect: (parsed.features && parsed.features.autoReconnect) ?? DEFAULT_CONFIG.features.autoReconnect,
        maxReconnectAttempts: (parsed.features && parsed.features.maxReconnectAttempts) ?? DEFAULT_CONFIG.features.maxReconnectAttempts,
        reconnectDelayMs: (parsed.features && parsed.features.reconnectDelayMs) ?? DEFAULT_CONFIG.features.reconnectDelayMs
      }
    };
  } catch (err) {
    console.error('[mcbot] Could not read mcbot.json, using built-in defaults instead:', err.message);
    return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  }
}

// =============================================================================
// STATE
// =============================================================================
let mcConfig = loadConfig();
let TID = mcConfig.groupTID;
let ADMIN_IDS = new Set(mcConfig.adminIds);
let lastApi = null;

let botInstance = null;
let botReady = false;
let connecting = false;
let intentionalShutdown = false;
let reconnectCount = 0;
let connectTimeoutHandle = null;
const lastPlayers = new Set();

let followTarget = null;
let combatEnabled = false;
let combatIntervalHandle = null;
let wanderIntervalHandle = null;

// Global safety net: one uncaught throw anywhere in a bot event handler
// used to be able to kill the entire Node process. That's the #1 cause of
// mystery disconnects that don't show a "kicked"/"error" message. This
// logs it and (if possible) tells you in chat, instead of dying silently.
if (!global.__mcbotSafetyNetInstalled) {
  global.__mcbotSafetyNetInstalled = true;
  process.on('uncaughtException', (err) => {
    console.error('[mcbot] uncaughtException (process kept alive):', err.stack || err.message);
    if (lastApi) {
      try { lastApi.sendMessage(`⚠️ mcbot internal error: ${err.message}`, TID); } catch (e) {}
    }
  });
  process.on('unhandledRejection', (reason) => {
    const msg = (reason && reason.message) ? reason.message : String(reason);
    console.error('[mcbot] unhandledRejection (process kept alive):', msg);
    if (lastApi) {
      try { lastApi.sendMessage(`⚠️ mcbot internal error: ${msg}`, TID); } catch (e) {}
    }
  });
}

// =============================================================================
// COMMAND HANDLER
// =============================================================================
module.exports = {
  config: {
    name: 'mcbot',
    version: '3.0',
    author: 'Sheikh | Akash',
    countDown: 3,
    role: 0,
    shortDescription: { en: 'MC Server Monitor' },
    longDescription: { en: 'Handles Minecraft server interactions' },
    category: 'minecraft',
    guide: {
      en: '{pn} start | stop | status | say <message> | pos | inv | inv drop <index> | come <x> <y> <z> | follow <player> | unfollow | combat <on|off> | reload'
    }
  },

  onStart: async function ({ api, args, event, message }) {
    if (!ADMIN_IDS.has(event.senderID)) {
      return message.reply("you don't have permission get out 🤣👎");
    }

    const action = (args[0] || '').toLowerCase();

    try {
      switch (action) {
        case 'start': {
          if (botInstance || connecting) {
            return api.sendMessage('Already active.', TID);
          }
          api.sendMessage(`Attempting to connect to ${mcConfig.server.host}:${mcConfig.server.port} ...`, TID);
          if (event.threadID !== TID) {
            message.reply('Connecting to the Minecraft server — check the mc group chat for the result.');
          }
          intentionalShutdown = false;
          initializeBot(api);
          return;
        }

        case 'stop': {
          if (!botInstance) return api.sendMessage('Bot is already stopped.', TID);
          terminateBot(api);
          return;
        }

        case 'status': {
          const lines = [
            `Connected: ${botReady ? 'yes' : 'no'}`,
            `Currently connecting: ${connecting ? 'yes' : 'no'}`,
            `Following: ${followTarget || 'nobody'}`,
            `Combat: ${combatEnabled ? 'on' : 'off'}${pvpPlugin ? '' : ' (mineflayer-pvp not installed)'}`,
            `Reconnect attempts used: ${reconnectCount}/${mcConfig.features.maxReconnectAttempts}`,
            `Server: ${mcConfig.server.host}:${mcConfig.server.port} (${mcConfig.server.version})`,
            `Config file: ${CONFIG_PATH}`
          ];
          return api.sendMessage(lines.join('\n'), TID);
        }

        case 'reload': {
          mcConfig = loadConfig();
          TID = mcConfig.groupTID;
          ADMIN_IDS = new Set(mcConfig.adminIds);
          return api.sendMessage(
            '✅ Reloaded mcbot.json.\nServer/account changes only take effect after "mcbot stop" then "mcbot start".',
            TID
          );
        }

        case 'say': {
          const text = args.slice(1).join(' ').trim();
          if (!text) return api.sendMessage('Usage: mcbot say <message>', TID);
          if (!botReady || !botInstance) return api.sendMessage("❌ Bot isn't connected right now.", TID);
          botInstance.chat(text);
          return api.sendMessage(`Sent to Minecraft chat: ${text}`, TID);
        }

        case 'pos': {
          if (!botReady || !botInstance || !botInstance.entity) {
            return api.sendMessage("❌ Bot isn't connected right now.", TID);
          }
          const p = botInstance.entity.position;
          const lines = [
            `Position: x=${p.x.toFixed(1)} y=${p.y.toFixed(1)} z=${p.z.toFixed(1)}`,
            `Health: ${botInstance.health ?? '?'}/20  Food: ${botInstance.food ?? '?'}/20`
          ];
          return api.sendMessage(lines.join('\n'), TID);
        }

        case 'inv': {
          if (!botReady || !botInstance) return api.sendMessage("❌ Bot isn't connected right now.", TID);

          const sub = (args[1] || '').toLowerCase();
          const items = botInstance.inventory.items();

          if (sub === 'drop') {
            const idx = parseInt(args[2], 10);
            if (Number.isNaN(idx) || idx < 0 || idx >= items.length) {
              return api.sendMessage('Invalid index. Run "mcbot inv" first to see the list.', TID);
            }
            const item = items[idx];
            try {
              await tossItem(botInstance, item);
              return api.sendMessage(`Dropped ${item.count}x ${item.displayName || item.name} (index ${idx}).`, TID);
            } catch (err) {
              return api.sendMessage(`❌ Failed to drop item: ${err.message}`, TID);
            }
          }

          if (items.length === 0) return api.sendMessage('Inventory is empty.', TID);
          const lines = items.map((it, i) => `[${i}] ${it.displayName || it.name} x${it.count}`);
          return api.sendMessage(`Inventory:\n${lines.join('\n')}\n\nUse "mcbot inv drop <index>" to drop one.`, TID);
        }

        case 'come': {
          if (!botReady || !botInstance) return api.sendMessage("❌ Bot isn't connected right now.", TID);
          const x = parseFloat(args[1]);
          const y = parseFloat(args[2]);
          const z = parseFloat(args[3]);
          if ([x, y, z].some((n) => Number.isNaN(n))) {
            return api.sendMessage('Usage: mcbot come <x> <y> <z>', TID);
          }
          followTarget = null;
          botInstance.pathfinder.setGoal(new GoalNear(x, y, z, 1));
          return api.sendMessage(`Heading to (${x}, ${y}, ${z})...`, TID);
        }

        case 'follow': {
          const targetName = args[1];
          if (!targetName) return api.sendMessage('Usage: mcbot follow <playername>', TID);
          if (!botReady || !botInstance) return api.sendMessage("❌ Bot isn't connected right now.", TID);

          const targetEntity = findPlayerEntity(targetName);
          if (!targetEntity) return api.sendMessage(`Can't see a player named ${targetName} nearby.`, TID);

          followTarget = targetName;
          botInstance.pathfinder.setGoal(new GoalFollow(targetEntity, 2), true);
          return api.sendMessage(`Now following ${targetName}.`, TID);
        }

        case 'unfollow': {
          if (!botReady || !botInstance) return api.sendMessage("❌ Bot isn't connected right now.", TID);
          followTarget = null;
          botInstance.pathfinder.setGoal(null);
          return api.sendMessage('Stopped following.', TID);
        }

        case 'combat': {
          if (!pvpPlugin) {
            return api.sendMessage('Combat unavailable: run "npm install mineflayer-pvp" and restart the bot process.', TID);
          }
          const sub = (args[1] || '').toLowerCase();
          if (sub === 'on') {
            combatEnabled = true;
            startCombatLoop();
            return api.sendMessage('Combat mode: ON — will attack nearby hostile mobs.', TID);
          }
          if (sub === 'off') {
            combatEnabled = false;
            stopCombatLoop();
            return api.sendMessage('Combat mode: OFF.', TID);
          }
          return api.sendMessage('Usage: mcbot combat on|off', TID);
        }

        default: {
          return api.sendMessage(
            'Commands: start, stop, status, say <message>, pos, inv, inv drop <index>, come <x> <y> <z>, follow <player>, unfollow, combat <on|off>, reload',
            TID
          );
        }
      }
    } catch (err) {
      console.error('[mcbot] command handler error:', err.stack || err.message);
      return api.sendMessage(`❌ Something went wrong running that command: ${err.message}`, TID);
    }
  },

  onReply: async function ({ api, event, Reply, usersData }) {
    if (!ADMIN_IDS.has(event.senderID)) return;
    if (event.senderID !== Reply.author) return;
    if (!botInstance || !botReady) {
      return api.sendMessage("❌ Bot isn't connected right now.", event.threadID);
    }

    try {
      const senderName = await usersData.getName(event.senderID);
      const msg = event.body.trim();
      botInstance.chat(`msgplayer ${Reply.username}: By: ${senderName} - ${msg}`);
      api.sendMessage(`Sent message to ${Reply.username} in game.`, event.threadID);
    } catch (err) {
      api.sendMessage('❌ Failed to send message to Minecraft.', event.threadID);
    }
  }
};

// =============================================================================
// HELPERS
// =============================================================================
function findPlayerEntity(username) {
  if (!botInstance) return null;
  const playerInfo = botInstance.players[username];
  return (playerInfo && playerInfo.entity) || null;
}

// Wraps bot.tossStack so it works whether the installed mineflayer version
// uses a callback, a Promise, or both.
function tossItem(bot, item) {
  return new Promise((resolve, reject) => {
    let settled = false;
    try {
      const maybePromise = bot.tossStack(item, (err) => {
        if (settled) return;
        settled = true;
        if (err) reject(err);
        else resolve();
      });
      if (maybePromise && typeof maybePromise.then === 'function') {
        maybePromise.then(() => {
          if (!settled) { settled = true; resolve(); }
        }).catch((err) => {
          if (!settled) { settled = true; reject(err); }
        });
      }
    } catch (err) {
      if (!settled) { settled = true; reject(err); }
    }
  });
}

const HOSTILE_TYPES = new Set([
  'zombie', 'skeleton', 'spider', 'creeper', 'enderman',
  'witch', 'zombie_villager', 'husk', 'stray', 'drowned', 'phantom'
]);

function startCombatLoop() {
  stopCombatLoop();
  if (!pvpPlugin) return;

  combatIntervalHandle = setInterval(() => {
    try {
      if (!combatEnabled || !botInstance || !botReady || !botInstance.entity) return;
      if (followTarget) return;

      const selfHealth = botInstance.health ?? 20;
      if (selfHealth <= 6) return;

      const selfPos = botInstance.entity.position;

      const candidates = Object.values(botInstance.entities)
        .filter((e) => e && e.position && e.type === 'mob' && HOSTILE_TYPES.has(e.name))
        .filter((e) => e.position.distanceTo(selfPos) <= 12)
        .sort((a, b) => a.position.distanceTo(selfPos) - b.position.distanceTo(selfPos));

      const nearest = candidates[0];
      if (!nearest) return;

      if (nearest.name === 'creeper' && nearest.position.distanceTo(selfPos) < 3) return;

      botInstance.pvp.attack(nearest);
    } catch (err) {
      console.error('[mcbot] combat loop error (ignored):', err.message);
    }
  }, 1000);
}

function stopCombatLoop() {
  if (combatIntervalHandle) {
    clearInterval(combatIntervalHandle);
    combatIntervalHandle = null;
  }
  if (botInstance && botInstance.pvp) {
    try { botInstance.pvp.stop(); } catch (e) {}
  }
}

function startAntiAFKWander() {
  stopAntiAFKWander();
  if (!mcConfig.features.antiAFK.enabled) return;

  wanderIntervalHandle = setInterval(() => {
    try {
      if (!botInstance || !botReady || followTarget) return;
      const dirs = ['forward', 'back', 'left', 'right'];
      const dir = dirs[Math.floor(Math.random() * dirs.length)];
      botInstance.setControlState(dir, true);
      setTimeout(() => {
        if (botInstance) botInstance.setControlState(dir, false);
      }, 700);
    } catch (err) {
      console.error('[mcbot] anti-afk error (ignored):', err.message);
    }
  }, 15000);
}

function stopAntiAFKWander() {
  if (wanderIntervalHandle) {
    clearInterval(wanderIntervalHandle);
    wanderIntervalHandle = null;
  }
}

// =============================================================================
// CONNECTION LIFECYCLE
// =============================================================================
function initializeBot(api) {
  if (connecting) return;
  connecting = true;
  lastApi = api;

  // If nothing happens for 20s, by far the most common cause is that the
  // target server itself is offline/asleep (e.g. Aternos servers only run
  // once someone starts them from aternos.org — this bot cannot wake it up).
  connectTimeoutHandle = setTimeout(() => {
    if (!botReady) {
      api.sendMessage(
        `Still not connected after 20s to ${mcConfig.server.host}:${mcConfig.server.port}.\n` +
        'Most likely cause: the Minecraft server itself is offline or asleep — start it from its host panel first (e.g. Aternos). ' +
        'This will keep retrying in the background. Run "mcbot status" to check progress.',
        TID
      );
    }
  }, 20000);

  let bot;
  try {
    bot = mineflayer.createBot({
      username: mcConfig.botAccount.username,
      password: mcConfig.botAccount.password,
      auth: mcConfig.botAccount.auth,
      host: mcConfig.server.host,
      port: mcConfig.server.port,
      version: mcConfig.server.version
    });
  } catch (err) {
    clearTimeout(connectTimeoutHandle);
    connecting = false;
    console.error('[mcbot] createBot threw synchronously:', err.stack || err.message);
    api.sendMessage(`❌ Could not start connecting: ${err.message}`, TID);
    return;
  }

  botInstance = bot;

  try {
    bot.loadPlugin(pathfinder);
    if (pvpPlugin) bot.loadPlugin(pvpPlugin);
  } catch (err) {
    console.error('[mcbot] plugin load error:', err.stack || err.message);
    api.sendMessage(`⚠️ A plugin failed to load: ${err.message}`, TID);
  }

  let lastHealth = 20;

  bot.once('spawn', () => {
    clearTimeout(connectTimeoutHandle);
    connecting = false;
    botReady = true;
    reconnectCount = 0;
    lastHealth = bot.health ?? 20;

    api.sendMessage('✅ Connected to server.', TID);

    try {
      const movements = new Movements(bot);
      bot.pathfinder.setMovements(movements);
    } catch (err) {
      console.error('[mcbot] pathfinder setup error:', err.message);
    }

    if (mcConfig.features.autoAuth.enabled) {
      try {
        const pw = mcConfig.features.autoAuth.password;
        bot.chat(`/register ${pw} ${pw}`);
        bot.chat(`/login ${pw}`);
      } catch (err) {
        console.error('[mcbot] autoAuth error:', err.message);
      }
    }

    lastPlayers.clear();
    Object.keys(bot.players).forEach((name) => {
      if (name !== bot.username) lastPlayers.add(name);
    });

    startAntiAFKWander();
    if (combatEnabled) startCombatLoop();
  });

  // Anti-cheat safety net: on many servers (Aternos default anti-cheat
  // included), taking knockback while pathfinder is also forcing movement
  // in the same tick looks like an illegal move and gets the bot kicked.
  // Release movement briefly on damage, then resume any active follow goal.
  bot.on('health', () => {
    try {
      const currentHealth = bot.health ?? 20;
      if (currentHealth < lastHealth) {
        const resumeFollow = followTarget;
        if (bot.pathfinder) bot.pathfinder.setGoal(null);
        ['forward', 'back', 'left', 'right', 'jump'].forEach((c) => bot.setControlState(c, false));

        if (resumeFollow) {
          setTimeout(() => {
            if (botInstance === bot && botReady && followTarget === resumeFollow) {
              const ent = findPlayerEntity(resumeFollow);
              if (ent) bot.pathfinder.setGoal(new GoalFollow(ent, 2), true);
            }
          }, 500);
        }
      }
      lastHealth = currentHealth;
    } catch (err) {
      console.error('[mcbot] health-safety handler error:', err.message);
    }
  });

  bot.on('playerJoined', (player) => {
    try {
      if (!lastPlayers.has(player.username)) {
        lastPlayers.add(player.username);
        api.sendMessage(`A user named ${player.username} joined the server.`, TID);
      }
    } catch (err) {
      console.error('[mcbot] playerJoined handler error:', err.message);
    }
  });

  bot.on('playerLeft', (player) => {
    try {
      if (lastPlayers.has(player.username)) {
        lastPlayers.delete(player.username);
        api.sendMessage(`A user named ${player.username} left the server.`, TID);
      }
      if (followTarget === player.username) {
        followTarget = null;
        if (bot.pathfinder) bot.pathfinder.setGoal(null);
        api.sendMessage(`${player.username} left — stopped following.`, TID);
      }
    } catch (err) {
      console.error('[mcbot] playerLeft handler error:', err.message);
    }
  });

  bot.on('chat', (username, messageText) => {
    if (username === bot.username) return;
    try {
      api.sendMessage(`${username}: ${messageText}`, TID, (err, info) => {
        if (!err && info && info.messageID && global.GoatBot && global.GoatBot.onReply) {
          global.GoatBot.onReply.set(info.messageID, {
            commandName: 'mcbot',
            messageID: info.messageID,
            username
          });
        }
      });
    } catch (err) {
      console.error('[mcbot] chat relay error:', err.message);
    }
  });

  bot.on('kicked', (reason) => {
    clearTimeout(connectTimeoutHandle);
    console.error('[mcbot] kicked:', reason);
    api.sendMessage(`Kicked from server: ${reason}`, TID);
  });

  bot.on('end', (reason) => {
    clearTimeout(connectTimeoutHandle);
    connecting = false;
    botReady = false;
    stopCombatLoop();
    stopAntiAFKWander();
    if (botInstance === bot) botInstance = null;

    if (intentionalShutdown) return;

    console.error('[mcbot] connection ended:', reason || 'no reason given');
    api.sendMessage(`Disconnected (reason: ${reason || 'unknown'}).`, TID);

    if (mcConfig.features.autoReconnect && reconnectCount < mcConfig.features.maxReconnectAttempts) {
      reconnectCount++;
      setTimeout(() => initializeBot(api), mcConfig.features.reconnectDelayMs);
    } else if (reconnectCount >= mcConfig.features.maxReconnectAttempts) {
      api.sendMessage("Gave up reconnecting after repeated failures. Run 'mcbot start' to try again.", TID);
    }
  });

  bot.on('error', (err) => {
    clearTimeout(connectTimeoutHandle);
    console.error('[mcbot] connection error:', err.stack || err.message);
    api.sendMessage(`Connection error: ${err.message}`, TID);
  });
}

function terminateBot(api) {
  if (!botInstance) return;
  intentionalShutdown = true;
  clearTimeout(connectTimeoutHandle);
  stopCombatLoop();
  stopAntiAFKWander();
  followTarget = null;
  try {
    botInstance.removeAllListeners();
    botInstance.end();
  } catch (err) {
    console.error('[mcbot] error while stopping bot:', err.message);
  }
  botInstance = null;
  botReady = false;
  connecting = false;
  reconnectCount = 0;
  lastPlayers.clear();
  api.sendMessage('Disconnected.', TID);
}
