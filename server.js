const http = require('http');
const { WebSocketServer } = require('ws');
const Redis = require('ioredis');

const PORT = process.env.PORT || 3000;

// History settings
const MESSAGE_TTL = 24 * 60 * 60 * 1000;
const MAX_HISTORY = 100;

// NEW: inactivity clear (10 minutes)
const INACTIVITY_CLEAR_MS = 10 * 60 * 1000;

// Spam/mute settings
const DUP_RESET_MS = 60 * 1000;
const DUP_LIMIT = 3;

const OFFENSE_MUTES_MS = [5000, 10000, 30000];
const OFFENSE_RESET_MS = 10 * 60 * 1000;

const redis = new Redis(process.env.REDIS_URL);

let messageHistory = [];
let historyLoaded = false;

// NEW: inactivity timer handle
let inactivityTimer = null;

function broadcast(data, exclude = null) {
  const msg = JSON.stringify(data);
  for (const c of wss.clients) {
    if (c !== exclude && c.readyState === 1) c.send(msg);
  }
}

// NEW: clear history + announce
async function clearHistoryDueToInactivity() {
  messageHistory = [];

  try {
    await redis.set("history", JSON.stringify(messageHistory));
    await redis.set("lastActivity", String(Date.now()));
  } catch (e) {
    console.error("history clear/save failed:", e);
  }

  // Log to chat (system message). Not added to history (history is being cleared).
  broadcast({
    type: "system",
    text: `Chat cleared after 10 minutes of inactivity`,
    timestamp: Date.now()
  });
}

// NEW: reset inactivity timer (called on every message)
function resetInactivityTimer() {
  if (inactivityTimer) clearTimeout(inactivityTimer);
  inactivityTimer = setTimeout(() => {
    clearHistoryDueToInactivity().catch(err =>
      console.error("inactivity clear failed:", err)
    );
  }, INACTIVITY_CLEAR_MS);
}

async function loadHistory() {
  if (historyLoaded) return;

  try {
    // NEW: if last activity was too long ago, clear immediately
    const lastActivityRaw = await redis.get("lastActivity");
    const lastActivity = lastActivityRaw ? Number(lastActivityRaw) : 0;

    if (lastActivity && (Date.now() - lastActivity > INACTIVITY_CLEAR_MS)) {
      await clearHistoryDueToInactivity();
    }

    const raw = await redis.get("history");
    if (raw) {
      const parsed = JSON.parse(raw);
      const cutoff = Date.now() - MESSAGE_TTL;
      messageHistory = parsed.filter(m => m.timestamp > cutoff);
    }
  } catch (e) {
    console.error("history load failed:", e);
  }

  historyLoaded = true;
}

async function saveHistory() {
  try {
    await redis.set("history", JSON.stringify(messageHistory));
  } catch (e) {
    console.error("history save failed:", e);
  }
}

function addToHistory(msg) {
  messageHistory.push(msg);

  if (messageHistory.length > MAX_HISTORY)
    messageHistory = messageHistory.slice(-MAX_HISTORY);

  saveHistory();
}

function sanitizeName(n) {
  return (n || "")
    .replace(/[^a-zA-Z0-9_\-]/g, "")
    .slice(0, 20);
}

function isDuplicateSpam(sess, text) {
  const now = Date.now();

  if (!sess.spam) sess.spam = { last: "", count: 0, lastAt: 0 };

  if (now - sess.spam.lastAt > DUP_RESET_MS) {
    sess.spam.count = 0;
    sess.spam.last = "";
  }

  if (text.toLowerCase() === sess.spam.last) sess.spam.count++;
  else {
    sess.spam.last = text.toLowerCase();
    sess.spam.count = 1;
  }

  sess.spam.lastAt = now;

  return sess.spam.count > DUP_LIMIT;
}

function escalateMute(sess) {
  const now = Date.now();

  if (!sess.offenses) sess.offenses = { count: 0, lastAt: 0 };

  if (now - sess.offenses.lastAt > OFFENSE_RESET_MS) sess.offenses.count = 0;

  sess.offenses.count++;
  sess.offenses.lastAt = now;

  const duration =
    OFFENSE_MUTES_MS[
      Math.min(sess.offenses.count - 1, OFFENSE_MUTES_MS.length - 1)
    ];

  sess.muteUntil = now + duration;

  return duration;
}

const server = http.createServer((req, res) => {
  res.writeHead(200);
  res.end("ok\n");
});

const wss = new WebSocketServer({ server });
const clients = new Map();

function getUserList() {
  return Array.from(clients.values()).map(s => ({ username: s.username }));
}

wss.on("connection", (ws) => {
  let username = null;

  ws.on("message", async raw => {
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      return;
    }

    if (data.type === "ping") {
      ws.send(JSON.stringify({ type: "pong" }));
      return;
    }

    if (data.type === "join") {
      const name = sanitizeName(data.username);
      if (!name) return;

      username = name;

      clients.set(ws, {
        username,
        muteUntil: 0,
        spam: null,
        offenses: null
      });

      await loadHistory();

      ws.send(JSON.stringify({
        type: "welcome",
        username,
        history: messageHistory,
        users: getUserList()
      }));

      broadcast({
        type: "system",
        text: `${username} connected`,
        timestamp: Date.now()
      }, ws);

      broadcast({
        type: "userlist",
        users: getUserList()
      });
    }

    else if (data.type === "message") {
      if (!username) return;

      const sess = clients.get(ws);
      if (!sess) return;

      if (sess.muteUntil && Date.now() < sess.muteUntil) return;

      const text = (data.text || "").trim();
      if (!text) return;

      if (isDuplicateSpam(sess, text)) {
        const duration = escalateMute(sess);

        broadcast({
          type: "system",
          text: `${username} muted for spam (${duration / 1000}s)`,
          timestamp: Date.now()
        });

        return;
      }

      // NEW: update last activity + reset inactivity timer on any valid message
      try {
        await redis.set("lastActivity", String(Date.now()));
      } catch (e) {
        console.error("lastActivity save failed:", e);
      }
      resetInactivityTimer();

      const msg = {
        type: "message",
        username,
        text,
        timestamp: Date.now()
      };

      broadcast(msg);
      addToHistory(msg);
    }

    else if (data.type === "typing") {
      if (!username) return;

      broadcast({
        type: "typing",
        username
      }, ws);
    }
  });

  ws.on("close", () => {
    if (!username) return;

    clients.delete(ws);

    broadcast({
      type: "system",
      text: `${username} disconnected`,
      timestamp: Date.now()
    });

    broadcast({
      type: "userlist",
      users: getUserList()
    });
  });
});

server.listen(PORT, () => console.log(`Server running on port ${PORT}`));