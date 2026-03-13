const http = require('http');
const { WebSocketServer } = require('ws');
const Redis = require('ioredis');

const PORT = process.env.PORT || 3000;

const MESSAGE_TTL = 24 * 60 * 60 * 1000;
const MAX_HISTORY = 100;

// Clear chat after 10 minutes without any chat messages
const INACTIVITY_CLEAR_MS = 10 * 60 * 1000;

const DUP_RESET_MS = 60 * 1000;
const DUP_LIMIT = 3;

const OFFENSE_MUTES_MS = [5000, 10000, 30000];
const OFFENSE_RESET_MS = 10 * 60 * 1000;

const redis = new Redis(process.env.REDIS_URL);

let messageHistory = [];
let historyLoaded = false;
let inactivityTimer = null;

async function loadHistory() {
  if (historyLoaded) return;

  try {
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

  if (messageHistory.length > MAX_HISTORY) {
    messageHistory = messageHistory.slice(-MAX_HISTORY);
  }

  saveHistory();
}

async function clearHistoryAndLog() {
  messageHistory = [];

  try {
    await redis.set("history", JSON.stringify(messageHistory));
  } catch (e) {
    console.error("history clear failed:", e);
  }

  broadcast({
    type: "system",
    text: "Messages cleared after 10 minutes of inactivity",
    timestamp: Date.now()
  });
}

function resetInactivityTimer() {
  clearTimeout(inactivityTimer);

  inactivityTimer = setTimeout(() => {
    clearHistoryAndLog().catch(err => {
      console.error("inactivity clear failed:", err);
    });
  }, INACTIVITY_CLEAR_MS);
}

const server = http.createServer((req, res) => {
  res.writeHead(200);
  res.end("ok\n");
});

const wss = new WebSocketServer({ server });

const clients = new Map();

function getUserList() {
  return Array.from(clients.values()).map(s => ({
    username: s.username
  }));
}

function broadcast(data, exclude = null) {
  const msg = JSON.stringify(data);

  for (const c of wss.clients) {
    if (c !== exclude && c.readyState === 1) {
      c.send(msg);
    }
  }
}

function sanitizeName(n) {
  return (n || "")
    .replace(/[^a-zA-Z0-9_\-]/g, "")
    .slice(0, 20);
}

function isDuplicateSpam(sess, text) {
  const now = Date.now();

  if (!sess.spam) {
    sess.spam = { last: "", count: 0, lastAt: 0 };
  }

  if (now - sess.spam.lastAt > DUP_RESET_MS) {
    sess.spam.count = 0;
    sess.spam.last = "";
  }

  if (text.toLowerCase() === sess.spam.last) {
    sess.spam.count++;
  } else {
    sess.spam.last = text.toLowerCase();
    sess.spam.count = 1;
  }

  sess.spam.lastAt = now;

  return sess.spam.count > DUP_LIMIT;
}

function escalateMute(sess) {
  const now = Date.now();

  if (!sess.offenses) {
    sess.offenses = { count: 0, lastAt: 0 };
  }

  if (now - sess.offenses.lastAt > OFFENSE_RESET_MS) {
    sess.offenses.count = 0;
  }

  sess.offenses.count++;
  sess.offenses.lastAt = now;

  const duration =
    OFFENSE_MUTES_MS[
      Math.min(sess.offenses.count - 1, OFFENSE_MUTES_MS.length - 1)
    ];

  sess.muteUntil = now + duration;

  return duration;
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

      if (sess.muteUntil && Date.now() < sess.muteUntil) {
        return;
      }

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

      // Fast: no Redis await here
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

server.listen(PORT, () =>
  console.log(`Server running on port ${PORT}`)
);