// hybra overchat relay — rotates outgoing IP per request through a proxy pool
// so overchat's per-IP quota can't lock us out.
//
// Run:  node relay.mjs
// Then: cloudflared tunnel --url http://localhost:8788

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { fetch as undiciFetch, ProxyAgent, Agent } from "undici";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.RELAY_PORT) || 8788;
const UPSTREAM = "https://api.overchat.ai";
const ORIGIN = "https://overchat.ai";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36";
const DEVICE_VERSION = "1.0.44";
const PROXY_FILE = process.env.RELAY_PROXY_FILE || path.join(__dirname, "proxies.txt");
const PROXY_TIMEOUT_MS = 20000;
const RETRIES_PER_REQUEST = 2;

const DIRECT = new Agent();

function loadProxies() {
  if (!fs.existsSync(PROXY_FILE)) return [];
  const lines = fs.readFileSync(PROXY_FILE, "utf8").split(/\r?\n/);
  const out = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    // ip:port:user:pass  or  ip:port
    const parts = line.split(":");
    if (parts.length < 2) continue;
    const [host, port, user, pass] = parts;
    const auth = user && pass ? `${encodeURIComponent(user)}:${encodeURIComponent(pass)}@` : "";
    out.push({ url: `http://${auth}${host}:${port}`, label: `${host}:${port}`, dead: false });
  }
  return out;
}

const PROXIES = loadProxies();

function pickProxy() {
  const alive = PROXIES.filter((p) => !p.dead);
  if (alive.length === 0) return null;
  return alive[Math.floor(Math.random() * alive.length)];
}

function markDead(proxy) {
  proxy.dead = true;
  console.warn(`  marked proxy dead: ${proxy.label} (${PROXIES.filter((p) => !p.dead).length} alive)`);
}

function browserHeaders(deviceUuid, extra = {}) {
  return {
    Accept: "*/*",
    "Accept-Language": "en-US,en;q=0.7",
    Origin: ORIGIN,
    Referer: ORIGIN + "/",
    "sec-ch-ua": '"Not=A?Brand";v="99", "Brave";v="151", "Chromium";v="151"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Windows"',
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-site",
    "sec-gpc": "1",
    "User-Agent": UA,
    "x-device-language": "en-US",
    "x-device-platform": "web",
    "x-device-uuid": deviceUuid,
    "x-device-version": DEVICE_VERSION,
    ...extra,
  };
}

async function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function fetchViaProxy(url, opts, proxy) {
  const dispatcher = proxy
    ? new ProxyAgent({ uri: proxy.url, requestTls: { rejectUnauthorized: true } })
    : DIRECT;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROXY_TIMEOUT_MS);
  try {
    return await undiciFetch(url, { ...opts, dispatcher, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

const server = http.createServer(async (req, res) => {
  const start = Date.now();
  try {
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "*",
      });
      res.end();
      return;
    }
    if (req.url === "/" || req.url === "/healthz") {
      res.writeHead(200, { "Content-Type": "application/json" });
      const alive = PROXIES.filter((p) => !p.dead).length;
      res.end(JSON.stringify({ service: "hybra-overchat-relay", proxies_total: PROXIES.length, proxies_alive: alive }));
      return;
    }

    const url = UPSTREAM + req.url;
    const deviceUuid = req.headers["x-device-uuid"] || randomUUID();
    const headers = browserHeaders(deviceUuid);
    if (req.headers["content-type"]) headers["Content-Type"] = req.headers["content-type"];
    if (req.headers["accept"]) headers.Accept = req.headers["accept"];

    const method = req.method || "GET";
    const body = method === "GET" || method === "HEAD" ? undefined : await readBody(req);

    let upstream;
    let usedProxy = null;
    let lastError = null;
    for (let attempt = 0; attempt <= RETRIES_PER_REQUEST; attempt++) {
      usedProxy = pickProxy();
      try {
        upstream = await fetchViaProxy(
          url,
          { method, headers, body: body && body.length > 0 ? body : undefined, redirect: "manual" },
          usedProxy,
        );
        // Retry on 403/429/5xx too (fresh IP may pass)
        if (usedProxy && (upstream.status === 403 || upstream.status === 429 || upstream.status >= 500)) {
          if (attempt < RETRIES_PER_REQUEST) {
            console.log(`  ${usedProxy.label} → ${upstream.status}, rotating`);
            upstream.body?.cancel().catch(() => {});
            continue;
          }
        }
        break;
      } catch (err) {
        lastError = err;
        if (usedProxy) markDead(usedProxy);
        if (attempt >= RETRIES_PER_REQUEST) throw err;
      }
    }

    if (!upstream) throw lastError ?? new Error("no response");

    const passHeaders = {};
    upstream.headers.forEach((value, key) => {
      const k = key.toLowerCase();
      if (k === "content-encoding" || k === "content-length" || k === "transfer-encoding") return;
      passHeaders[key] = value;
    });
    passHeaders["Access-Control-Allow-Origin"] = "*";

    res.writeHead(upstream.status, passHeaders);

    if (!upstream.body) {
      res.end();
    } else {
      const reader = upstream.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!res.write(Buffer.from(value))) {
          await new Promise((r) => res.once("drain", r));
        }
      }
      res.end();
    }

    const ms = Date.now() - start;
    const via = usedProxy ? usedProxy.label : "direct";
    console.log(`${new Date().toISOString()} ${method} ${req.url} → ${upstream.status} ${ms}ms via ${via}`);
  } catch (err) {
    console.error("relay error:", err?.message ?? err);
    if (!res.headersSent) res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: String(err?.message ?? err) } }));
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`hybra overchat relay listening on http://127.0.0.1:${PORT}`);
  console.log(`proxies loaded: ${PROXIES.length} from ${PROXY_FILE}`);
  console.log("");
  console.log(`expose publicly:  cloudflared tunnel --url http://localhost:${PORT}`);
});
