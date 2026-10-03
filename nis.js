"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const { chromium } = require("playwright");
const { execFile } = require("child_process");
const { promisify } = require("util");

const execFileAsync = promisify(execFile);

let ffmpegPath = null;

try {
  ffmpegPath = require("ffmpeg-static");
} catch {
  ffmpegPath = null;
}

const sessions = new Map();

const MAX_DURATION = 120;
const MIN_DURATION = 3;
const MAX_ACTIONS = 20;
const MAX_SCROLLS_PER_ACTION = 20;
const VIEWPORT = {
  width: 1280,
  height: 720
};

module.exports.config = {
  name: "sr",
  version: "2.0.0",
  author: "Shek",
  countDown: 15,
  role: 0,
  description: "Record a website with automated actions",
  category: "utility",
  guide: {
    en:
      "{pn} <url> <duration> [actions]\n\n" +
      "Examples:\n" +
      "{pn} youtube.com 30s\n" +
      "{pn} youtube.com 30s scroll5\n" +
      '{pn} example.com 30s click "Sign in"\n' +
      "{pn} example.com 30s write\n" +
      "{pn} example.com 30s signin\n" +
      '{pn} example.com 30s signin write scroll5 click "Submit"\n\n' +
      "Actions:\n" +
      "scroll5 = scroll 5 times\n" +
      'click "text" = click visible element by text\n' +
      "write = ask what text to type\n" +
      "signin = ask for username/email and password\n" +
      "cancel = cancel a waiting session"
  }
};

function sessionKey(threadID, senderID) {
  return `${threadID}:${senderID}`;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function parseDuration(value) {
  if (!value) return null;

  const input = String(value).trim().toLowerCase();

  let seconds = null;

  if (/^\d+(?:\.\d+)?s$/.test(input)) {
    seconds = Number.parseFloat(input.slice(0, -1));
  } else if (/^\d+(?:\.\d+)?m$/.test(input)) {
    seconds = Number.parseFloat(input.slice(0, -1)) * 60;
  } else if (/^\d+(?:\.\d+)?$/.test(input)) {
    seconds = Number.parseFloat(input);
  }

  if (!Number.isFinite(seconds)) return null;

  seconds = Math.floor(seconds);

  if (seconds < MIN_DURATION || seconds > MAX_DURATION) {
    return null;
  }

  return seconds;
}

function tokenize(input) {
  return input.match(/(?:[^\s"'`]+|"[^"]*"|'[^']*'|`[^`]*`)/g) || [];
}

function stripQuotes(value) {
  if (!value) return "";
  return value.replace(/^["'`]|["'`]$/g, "");
}

function parseActions(raw) {
  const tokens = tokenize(raw);
  const actions = [];

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const lower = token.toLowerCase();

    if (lower === "write") {
      actions.push({
        type: "write"
      });
      continue;
    }

    if (lower === "signin" || lower === "login") {
      actions.push({
        type: "signin"
      });
      continue;
    }

    const scrollMatch = lower.match(/^scroll(\d+)$/);

    if (scrollMatch) {
      const count = Number.parseInt(scrollMatch[1], 10);

      if (
        !Number.isInteger(count) ||
        count < 1 ||
        count > MAX_SCROLLS_PER_ACTION
      ) {
        throw new Error(
          `Scroll count must be between 1 and ${MAX_SCROLLS_PER_ACTION}.`
        );
      }

      actions.push({
        type: "scroll",
        count
      });

      continue;
    }

    if (lower === "scroll") {
      const next = tokens[i + 1];

      if (!next || !/^\d+$/.test(next)) {
        throw new Error("Use scroll5 or scroll 5.");
      }

      i++;

      const count = Number.parseInt(next, 10);

      if (
        !Number.isInteger(count) ||
        count < 1 ||
        count > MAX_SCROLLS_PER_ACTION
      ) {
        throw new Error(
          `Scroll count must be between 1 and ${MAX_SCROLLS_PER_ACTION}.`
        );
      }

      actions.push({
        type: "scroll",
        count
      });

      continue;
    }

    if (lower === "click") {
      const next = tokens[i + 1];

      if (!next) {
        throw new Error('Use click "Button text".');
      }

      i++;

      const text = stripQuotes(next).trim();

      if (!text) {
        throw new Error('Use click "Button text".');
      }

      actions.push({
        type: "click",
        text
      });

      continue;
    }

    throw new Error(`Unknown action: ${token}`);
  }

  if (actions.length > MAX_ACTIONS) {
    throw new Error(`Maximum ${MAX_ACTIONS} actions are allowed.`);
  }

  return actions;
}

function setReply(messageID, data) {
  if (!messageID) return;

  global.GoatBot.onReply.set(messageID, {
    messageID,
    commandName: "sr",
    ...data
  });
}

function askReply({
  api,
  event,
  question,
  sessionId,
  type,
  index = null
}) {
  return new Promise((resolve, reject) => {
    api.sendMessage(
      question,
      event.threadID,
      (err, info) => {
        if (err) {
          reject(err);
          return;
        }

        if (!info || !info.messageID) {
          reject(new Error("Could not register the reply handler."));
          return;
        }

        setReply(info.messageID, {
          author: event.senderID,
          threadID: event.threadID,
          sessionId,
          type,
          index
        });

        resolve(info);
      },
      event.messageID
    );
  });
}

async function visibleCount(locator) {
  const count = await locator.count();

  for (let i = 0; i < count; i++) {
    try {
      if (await locator.nth(i).isVisible()) {
        return i;
      }
    } catch {}
  }

  return -1;
}

async function findUsernameField(page) {
  const selectors = [
    'input[autocomplete="username"]',
    'input[type="email"]',
    'input[name*="email" i]',
    'input[name*="username" i]',
    'input[name*="user" i]',
    'input[name*="login" i]',
    'input[id*="email" i]',
    'input[id*="username" i]',
    'input[id*="user" i]',
    'input[placeholder*="email" i]',
    'input[placeholder*="username" i]',
    'input[placeholder*="user" i]',
    'input[type="text"]'
  ];

  for (const selector of selectors) {
    const locator = page.locator(selector);
    const index = await visibleCount(locator);

    if (index !== -1) {
      return locator.nth(index);
    }
  }

  return null;
}

async function findPasswordField(page) {
  const locator = page.locator('input[type="password"]');
  const index = await visibleCount(locator);

  if (index === -1) return null;

  return locator.nth(index);
}

async function findEditableField(page) {
  const selectors = [
    "textarea",
    'input:not([type="hidden"]):not([type="password"])',
    '[contenteditable="true"]'
  ];

  for (const selector of selectors) {
    const locator = page.locator(selector);
    const count = await locator.count();

    for (let i = 0; i < count; i++) {
      const item = locator.nth(i);

      try {
        if (
          await item.isVisible() &&
          await item.isEnabled()
        ) {
          return item;
        }
      } catch {}
    }
  }

  return null;
}

async function findButtonByText(page, patterns) {
  const candidates = page.locator(
    'button, input[type="submit"], [role="button"], a'
  );

  const count = await candidates.count();

  for (let i = 0; i < count; i++) {
    const item = candidates.nth(i);

    try {
      if (!(await item.isVisible()) || !(await item.isEnabled())) {
        continue;
      }

      const text = await item.evaluate(el => {
        return (
          el.innerText ||
          el.textContent ||
          el.value ||
          el.getAttribute("aria-label") ||
          el.getAttribute("title") ||
          ""
        ).trim();
      });

      if (!text) continue;

      const normalized = text.toLowerCase();

      if (
        patterns.some(pattern =>
          normalized.includes(pattern.toLowerCase())
        )
      ) {
        return item;
      }
    } catch {}
  }

  return null;
}

async function typeLikeHuman(locator, text) {
  await locator.scrollIntoViewIfNeeded().catch(() => {});

  try {
    await locator.fill("");
  } catch {}

  await locator.pressSequentially(String(text), {
    delay: 35
  });
}

async function performSignIn(page, credentials) {
  const usernameField = await findUsernameField(page);

  if (!usernameField) {
    throw new Error(
      "Could not find a username/email field on this website."
    );
  }

  await typeLikeHuman(usernameField, credentials.username);

  let passwordField = await findPasswordField(page);

  if (!passwordField) {
    const nextButton = await findButtonByText(page, [
      "next",
      "continue"
    ]);

    if (nextButton) {
      await nextButton.click().catch(() => {});
      await sleep(1800);
    }

    passwordField = await findPasswordField(page);
  }

  if (!passwordField) {
    throw new Error(
      "Could not find a password field after entering the username/email."
    );
  }

  await typeLikeHuman(passwordField, credentials.password);

  const submitButton = await findButtonByText(page, [
    "sign in",
    "log in",
    "login",
    "submit",
    "continue",
    "next",
    "verify"
  ]);

  if (submitButton) {
    await Promise.allSettled([
      submitButton.click(),
      page.waitForLoadState("domcontentloaded", {
        timeout: 10000
      })
    ]);
  } else {
    await passwordField.press("Enter").catch(() => {});
  }

  await sleep(2500);
}

async function performWrite(page, text) {
  const field = await findEditableField(page);

  if (!field) {
    throw new Error(
      "Could not find a visible text field, textarea, or contenteditable element."
    );
  }

  await typeLikeHuman(field, text);
}

async function performClick(page, text) {
  const exactCandidates = [
    page.getByRole("button", {
      name: new RegExp(escapeRegExp(text), "i")
    }),
    page.getByRole("link", {
      name: new RegExp(escapeRegExp(text), "i")
    }),
    page.getByText(
      new RegExp(escapeRegExp(text), "i")
    )
  ];

  for (const locator of exactCandidates) {
    const count = await locator.count();

    for (let i = 0; i < count; i++) {
      const item = locator.nth(i);

      try {
        if (
          await item.isVisible() &&
          await item.isEnabled()
        ) {
          await item.scrollIntoViewIfNeeded().catch(() => {});
          await item.click({
            timeout: 5000
          });
          return;
        }
      } catch {}
    }
  }

  throw new Error(
    `Could not find a visible clickable element matching "${text}".`
  );
}

function escapeRegExp(value) {
  return String(value).replace(
    /[.*+?^${}()|[\]\\]/g,
    "\\$&"
  );
}

async function performScroll(page, count) {
  for (let i = 0; i < count; i++) {
    await page.mouse.wheel(
      0,
      Math.round(VIEWPORT.height * 0.78)
    );

    await sleep(900);
  }
}

async function convertToMp4(inputPath, outputPath) {
  if (!ffmpegPath) {
    return false;
  }

  try {
    await execFileAsync(
      ffmpegPath,
      [
        "-y",
        "-i",
        inputPath,
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "28",
        "-pix_fmt",
        "yuv420p",
        "-movflags",
        "+faststart",
        "-an",
        outputPath
      ],
      {
        timeout: 300000
      }
    );

    return fs.existsSync(outputPath);
  } catch (error) {
    console.error(
      "[SR] FFmpeg conversion failed:",
      error.message
    );

    return false;
  }
}

async function runRecording(session) {
  const workDir = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "goat-sr-")
  );

  let browser = null;
  let context = null;
  let page = null;

  let webmPath = null;
  let mp4Path = null;
  let finalPath = null;

  try {
    browser = await chromium.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu"
      ]
    });

    context = await browser.newContext({
      viewport: VIEWPORT,
      recordVideo: {
        dir: workDir,
        size: VIEWPORT
      }
    });

    page = await context.newPage();

    page.setDefaultTimeout(10000);
    page.setDefaultNavigationTimeout(30000);

    await page.goto(session.url, {
      waitUntil: "domcontentloaded",
      timeout: 30000
    });

    await sleep(1500);

    const recordingStart = Date.now();

    for (const action of session.actions) {
      if (action.type === "signin") {
        if (!session.credentials) {
          throw new Error("Sign-in information is missing.");
        }

        await performSignIn(
          page,
          session.credentials
        );

        await sleep(700);
        continue;
      }

      if (action.type === "write") {
        if (!session.writeTexts || !session.writeTexts.length) {
          throw new Error("Write text is missing.");
        }

        const text = session.writeTexts.shift();

        await performWrite(page, text);

        await sleep(700);
        continue;
      }

      if (action.type === "scroll") {
        await performScroll(
          page,
          action.count
        );

        continue;
      }

      if (action.type === "click") {
        await performClick(
          page,
          action.text
        );

        await sleep(1000);
      }
    }

    const elapsed = Date.now() - recordingStart;
    const target = session.duration * 1000;
    const remaining = Math.max(
      0,
      target - elapsed
    );

    if (remaining > 0) {
      await sleep(remaining);
    }

    const video = page.video();

    if (!video) {
      throw new Error(
        "Playwright did not create a video."
      );
    }

    await context.close();

    webmPath = await video.path();

    if (
      !webmPath ||
      !fs.existsSync(webmPath)
    ) {
      throw new Error(
        "Recorded video file was not created."
      );
    }

    mp4Path = path.join(
      workDir,
      `recording-${Date.now()}.mp4`
    );

    const converted = await convertToMp4(
      webmPath,
      mp4Path
    );

    finalPath = converted
      ? mp4Path
      : webmPath;

    return {
      path: finalPath,
      format: converted ? "mp4" : "webm"
    };
  } finally {
    if (context) {
      await context.close().catch(() => {});
    }

    if (browser) {
      await browser.close().catch(() => {});
    }
  }
}

async function cleanupFile(filePath) {
  if (!filePath) return;

  try {
    if (fs.existsSync(filePath)) {
      await fs.promises.unlink(filePath);
    }
  } catch {}
}

async function cleanupDir(dir) {
  if (!dir) return;

  try {
    await fs.promises.rm(dir, {
      recursive: true,
      force: true
    });
  } catch {}
}

function removeSession(key) {
  const session = sessions.get(key);

  if (!session) return;

  session.destroyed = true;
  session.credentials = null;

  if (session.writeTexts) {
    session.writeTexts.fill(null);
  }

  sessions.delete(key);
}

function getPendingPrompts(session) {
  const prompts = [];

  for (let i = 0; i < session.actions.length; i++) {
    const action = session.actions[i];

    if (action.type === "signin") {
      prompts.push({
        type: "username",
        actionIndex: i
      });

      prompts.push({
        type: "password",
        actionIndex: i
      });
    }

    if (action.type === "write") {
      prompts.push({
        type: "write",
        actionIndex: i
      });
    }
  }

  return prompts;
}

async function continueSession({
  api,
  event,
  session
}) {
  const prompts = getPendingPrompts(session);

  if (session.promptIndex >= prompts.length) {
    await messageProgress(
      api,
      event,
      session,
      "🎥 Starting recording..."
    );

    await startRecordingNow({
      api,
      event,
      session
    });

    return;
  }

  const prompt = prompts[session.promptIndex];

  if (prompt.type === "username") {
    await askReply({
      api,
      event,
      question:
        "👤 Enter the username/email for the website.\n\n" +
        "Your reply will be used only for this recording session.",
      sessionId: session.id,
      type: "username"
    });

    return;
  }

  if (prompt.type === "password") {
    await askReply({
      api,
      event,
      question:
        "🔐 Enter the password.\n\n" +
        "It will not be echoed by the bot.",
      sessionId: session.id,
      type: "password"
    });

    return;
  }

  if (prompt.type === "write") {
    await askReply({
      api,
      event,
      question:
        "✍️ What should I type into the first visible text field?",
      sessionId: session.id,
      type: "write"
    });
  }
}

async function messageProgress(
  api,
  event,
  session,
  text
) {
  try {
    await api.sendMessage(
      text,
      event.threadID,
      null,
      event.messageID
    );
  } catch {}
}

async function startRecordingNow({
  api,
  event,
  session
}) {
  const key = sessionKey(
    event.threadID,
    event.senderID
  );

  let result = null;

  try {
    result = await runRecording(session);

    if (session.destroyed) {
      return;
    }

    const body =
      "🎬 Website recording complete\n\n" +
      `🌐 ${session.url}\n` +
      `⏱️ ${session.duration}s\n` +
      `📦 ${result.format.toUpperCase()}`;

    await api.sendMessage(
      {
        body,
        attachment: fs.createReadStream(
          result.path
        )
      },
      event.threadID,
      null,
      event.messageID
    );
  } catch (error) {
    console.error(
      "[SR]",
      error
    );

    if (!session.destroyed) {
      await api.sendMessage(
        "❌ Recording failed.\n\n" +
          `${error.message || "Unknown error"}`,
        event.threadID,
        null,
        event.messageID
      );
    }
  } finally {
    removeSession(key);

    if (result && result.path) {
      await cleanupFile(result.path);
    }
  }
}

module.exports.onStart = async function ({
  api,
  event,
  args,
  message
}) {
  const key = sessionKey(
    event.threadID,
    event.senderID
  );

  if (sessions.has(key)) {
    return message.reply(
      "⚠️ You already have an active /sr session.\n\n" +
      "Reply `cancel` to the current prompt first."
    );
  }

  if (!args || !args.length) {
    return message.reply(
      "🎥 Website Screen Recorder\n\n" +
        "Usage:\n" +
        "/sr <url> <duration> [actions]\n\n" +
        "Examples:\n" +
        "/sr youtube.com 30s\n" +
        "/sr youtube.com 30s scroll5\n" +
        '/sr example.com 30s click "Sign in"\n' +
        "/sr example.com 30s write\n" +
        "/sr example.com 30s signin\n\n" +
        "Max duration: 120 seconds\n" +
        "Reply `cancel` during a prompt to cancel."
    );
  }

  const urlInput = String(args[0]).trim();

  if (!urlInput) {
    return message.reply(
      "❌ Please provide a website URL."
    );
  }

  let url;

  try {
    url = /^https?:\/\//i.test(urlInput)
      ? new URL(urlInput)
      : new URL(`https://${urlInput}`);
  } catch {
    return message.reply(
      "❌ Invalid website URL."
    );
  }

  if (
    !["http:", "https:"].includes(url.protocol)
  ) {
    return message.reply(
      "❌ Only HTTP and HTTPS websites are supported."
    );
  }

  const duration = parseDuration(args[1]);

  if (!duration) {
    return message.reply(
      `❌ Duration must be between ${MIN_DURATION} and ${MAX_DURATION} seconds.\n\n` +
        "Examples: 10s, 30s, 1m"
    );
  }

  let actions;

  try {
    actions = parseActions(
      args.slice(2).join(" ")
    );
  } catch (error) {
    return message.reply(
      `❌ ${error.message}`
    );
  }

  const session = {
    id:
      `${Date.now()}-${Math.random()
        .toString(36)
        .slice(2)}`,
    threadID: event.threadID,
    senderID: event.senderID,
    url: url.href,
    duration,
    actions,
    promptIndex: 0,
    credentials: null,
    writeTexts: [],
    destroyed: false
  };

  if (
    actions.some(
      action => action.type === "signin"
    )
  ) {
    const signinCount = actions.filter(
      action => action.type === "signin"
    ).length;

    if (signinCount > 1) {
      return message.reply(
        "❌ Only one signin action is allowed per recording."
      );
    }

    session.credentials = {
      username: null,
      password: null
    };
  }

  const writeCount = actions.filter(
    action => action.type === "write"
  ).length;

  for (let i = 0; i < writeCount; i++) {
    session.writeTexts.push(null);
  }

  sessions.set(key, session);

  if (!actions.length) {
    session.promptIndex = 0;

    await message.reply(
      "🎥 Recording website...\n\n" +
        `🌐 ${session.url}\n` +
        `⏱️ ${session.duration}s`
    );

    await startRecordingNow({
      api,
      event,
      session
    });

    return;
  }

  await message.reply(
    "✅ Recording session created.\n\n" +
      `🌐 ${session.url}\n` +
      `⏱️ ${session.duration}s\n` +
      `🎬 Actions: ${actions.length}`
  );

  await continueSession({
    api,
    event,
    session
  });
};

module.exports.onReply = async function ({
  api,
  event,
  Reply,
  message
}) {
  if (!Reply) return;

  if (
    Reply.commandName !== "sr" ||
    Reply.author !== event.senderID ||
    Reply.threadID !== event.threadID
  ) {
    return;
  }

  const key = sessionKey(
    event.threadID,
    event.senderID
  );

  const session = sessions.get(
    key
  );

  if (
    !session ||
    session.id !== Reply.sessionId
  ) {
    return message.reply(
      "❌ This /sr session has expired."
    );
  }

  const answer = String(
    event.body || ""
  ).trim();

  if (!answer) {
    return message.reply(
      "❌ Please send a value."
    );
  }

  if (
    answer.toLowerCase() === "cancel"
  ) {
    removeSession(key);

    return message.reply(
      "🛑 /sr session cancelled."
    );
  }

  const prompts = getPendingPrompts(
    session
  );

  const current =
    prompts[session.promptIndex];

  if (!current) {
    return;
  }

  if (
    Reply.type !== current.type
  ) {
    return message.reply(
      "⚠️ Please reply to the latest /sr question."
    );
  }

  if (
    current.type === "username"
  ) {
    session.credentials.username =
      answer;
  } else if (
    current.type === "password"
  ) {
    session.credentials.password =
      answer;
  } else if (
    current.type === "write"
  ) {
    const writeNumber =
      prompts
        .slice(0, session.promptIndex + 1)
        .filter(
          prompt =>
            prompt.type === "write"
        ).length - 1;

    session.writeTexts[writeNumber] =
      answer;
  }

  session.promptIndex++;

  await continueSession({
    api,
    event,
    session
  });
};
