const http = require("http");
const fs = require("fs");
const path = require("path");

function loadEnv() {
  const envPath = path.join(__dirname, ".env");
  if (!fs.existsSync(envPath)) return;

  const content = fs.readFileSync(envPath, "utf8");
  content.split(/\r?\n/).forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return;
    const index = trimmed.indexOf("=");
    if (index === -1) return;
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim();
    if (key && !process.env[key]) {
      process.env[key] = value;
    }
  });
}

loadEnv();

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
let activeChatId = process.env.TELEGRAM_CHAT_ID;
const PORT = Number(process.env.PORT) || 8765;
const ENV_PATH = path.join(__dirname, ".env");

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".webp": "image/webp",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 1e6) {
        reject(new Error("Payload too large"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function sendJson(res, statusCode, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    ...extraHeaders,
  });
  res.end(body);
}

const API_CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function persistChatId(chatId) {
  if (!fs.existsSync(ENV_PATH)) return;

  const content = fs.readFileSync(ENV_PATH, "utf8");
  const updated = content.replace(/^TELEGRAM_CHAT_ID=.*$/m, `TELEGRAM_CHAT_ID=${chatId}`);
  if (updated !== content) {
    fs.writeFileSync(ENV_PATH, updated, "utf8");
  }
}

async function sendToTelegram(message, chatId = activeChatId) {
  const response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: message,
    }),
  });

  const data = await response.json();
  if (!response.ok || !data.ok) {
    const migratedChatId = data.parameters?.migrate_to_chat_id;
    if (migratedChatId && String(chatId) !== String(migratedChatId)) {
      activeChatId = String(migratedChatId);
      persistChatId(activeChatId);
      console.log(`Telegram chat migrated. New chat ID: ${activeChatId}`);
      return sendToTelegram(message, activeChatId);
    }

    throw new Error(data.description || "Telegram API error");
  }

  return data;
}

function serveStatic(req, res) {
  let urlPath = decodeURIComponent(req.url.split("?")[0]);
  if (urlPath === "/") urlPath = "/index.html";

  const filePath = path.join(__dirname, urlPath);
  if (!filePath.startsWith(__dirname)) {
    sendJson(res, 403, { ok: false, error: "Forbidden" });
    return;
  }

  fs.readFile(filePath, (error, content) => {
    if (error) {
      if (error.code === "ENOENT") {
        sendJson(res, 404, { ok: false, error: "Not found" });
        return;
      }
      sendJson(res, 500, { ok: false, error: "Server error" });
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { "Content-Type": MIME_TYPES[ext] || "application/octet-stream" });
    res.end(content);
  });
}

const server = http.createServer(async (req, res) => {
  if (req.url === "/api/callback" && req.method === "OPTIONS") {
    res.writeHead(204, API_CORS_HEADERS);
    res.end();
    return;
  }

  if (req.method === "POST" && req.url === "/api/callback") {
    try {
      if (!BOT_TOKEN || !activeChatId) {
        sendJson(res, 500, { ok: false, error: "Telegram is not configured" }, API_CORS_HEADERS);
        return;
      }

      const rawBody = await readBody(req);
      const payload = JSON.parse(rawBody || "{}");
      const name = String(payload.name || "").trim();
      const phone = String(payload.phone || "").trim();
      const comment = String(payload.comment || "").trim();

      if (!name || !phone) {
        sendJson(res, 400, { ok: false, error: "Name and phone are required" }, API_CORS_HEADERS);
        return;
      }

      let message = `📞 Новая заявка с сайта\n\nИмя: ${name}\nТелефон: ${phone}`;
      if (comment) {
        message += `\nКомментарий: ${comment}`;
      }

      await sendToTelegram(message);
      sendJson(res, 200, { ok: true }, API_CORS_HEADERS);
    } catch (error) {
      sendJson(res, 500, { ok: false, error: error.message || "Failed to send" }, API_CORS_HEADERS);
    }
    return;
  }

  if (req.method === "GET") {
    serveStatic(req, res);
    return;
  }

  sendJson(res, 405, { ok: false, error: "Method not allowed" });
});

server.listen(PORT, () => {
  console.log(`Server running at http://127.0.0.1:${PORT}`);
});
