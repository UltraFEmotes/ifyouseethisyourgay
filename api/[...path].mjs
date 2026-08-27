// Vercel Node serverless function — proxies /api/v1/* to api.overchat.ai,
// rotating outgoing IP through a proxy pool loaded from PROXY_LIST env var.

import { randomUUID } from "node:crypto";
import { fetch as undiciFetch, ProxyAgent, Agent } from "undici";

export const config = {
  runtime: "nodejs",
  maxDuration: 30,
};

const UPSTREAM = "https://api.overchat.ai";
const ORIGIN = "https://overchat.ai";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36";
const DEVICE_VERSION = "1.0.44";
const PROXY_TIMEOUT_MS = 20000;
const RETRIES_PER_REQUEST = 2;

const DIRECT = new Agent();

function loadProxies() {
  const raw = (process.env.PROXY_LIST ?? "").trim();
  if (!raw) return [];
  const lines = raw.split(/\r?\n/);
  const out = [];
  for (const line of lines) {
    const s = line.trim();
    if (!s || s.startsWith("#")) continue;
    const parts = s.split(":");
    if (parts.length < 2) continue;
    const [host, port, user, pass] = parts;
    const auth = user && pass ? `${encodeURIComponent(user)}:${encodeURIComponent(pass)}@` : "";
    out.push({ url: `http://${auth}${host}:${port}`, label: `${host}:${port}`, dead: false });
  }
  return out;
}

// Cache across warm invocations
const PROXIES = loadProxies();

function pickProxy() {
  const alive = PROXIES.filter((p) => !p.dead);
  if (alive.length === 0) return null;
  return alive[Math.floor(Math.random() * alive.length)];
}

function browserHeaders(deviceUuid, contentType, accept) {
  const h = {
    Accept: accept || "*/*",
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
  };
  if (contentType) h["Content-Type"] = contentType;
  return h;
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

export default async function handler(req, res) {
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

    // Vercel routes /api/foo/bar → this fn with req.url = "/api/foo/bar?path=foo/bar".
    // Split off the query, strip the "/api" prefix, and drop the synthetic
    // `path=` param that Vercel adds from the catch-all.
    const raw = req.url || "/";
    const qIdx = raw.indexOf("?");
    let path = qIdx >= 0 ? raw.slice(0, qIdx) : raw;
    const rawQuery = qIdx >= 0 ? raw.slice(qIdx + 1) : "";
    if (path.startsWith("/api/")) path = path.slice(4);
    else if (path === "/api") path = "/";
    const params = new URLSearchParams(rawQuery);
    params.delete("path");
    const query = params.toString();
    const suffix = query ? `?${query}` : "";

    if (path === "/" || path === "/healthz") {
      res.writeHead(200, { "Content-Type": "application/json" });
      const alive = PROXIES.filter((p) => !p.dead).length;
      res.end(
        JSON.stringify({
          service: "hybra-overchat-relay",
          runtime: "vercel-node",
          proxies_total: PROXIES.length,
          proxies_alive: alive,
        }),
      );
      return;
    }

    const url = UPSTREAM + path + suffix;
    const deviceUuid = req.headers["x-device-uuid"] || randomUUID();
    const headers = browserHeaders(deviceUuid, req.headers["content-type"], req.headers["accept"]);

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
        if (usedProxy && (upstream.status === 403 || upstream.status === 429 || upstream.status >= 500)) {
          if (attempt < RETRIES_PER_REQUEST) {
            upstream.body?.cancel().catch(() => {});
            continue;
          }
        }
        break;
      } catch (err) {
        lastError = err;
        if (usedProxy) usedProxy.dead = true;
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
      return;
    }
    const reader = upstream.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!res.write(Buffer.from(value))) {
        await new Promise((r) => res.once("drain", r));
      }
    }
    res.end();
  } catch (err) {
    if (!res.headersSent) res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: String(err?.message ?? err) } }));
  }
}
