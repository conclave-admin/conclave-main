const dns = require("node:dns").promises;
const http = require("node:http");
const https = require("node:https");
const net = require("node:net");

const MAX_HTML = 256 * 1024;
const cache = new Map();

function publicAddress(address) {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b, c] = parts;
  return !(
    a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 0 || b === 168)) ||
    (a === 198 && b >= 18 && b <= 19) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113)
  );
}

function allowedUrl(input) {
  if (typeof input !== "string" || input.length > 2048) return null;
  let url;
  try { url = new URL(input); } catch { return null; }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password ||
      url.port && !["80", "443"].includes(url.port) || net.isIP(url.hostname) ||
      !url.hostname.includes(".") || url.hostname.endsWith(".localhost") ||
      url.hostname.endsWith(".local")) return null;
  url.hash = "";
  return url;
}

function decode(value) {
  return String(value || "")
    .replace(/&(#x[0-9a-f]+|#[0-9]+|amp|quot|apos|lt|gt|nbsp);/gi, (_, entity) => {
      const named = { amp: "&", quot: '"', apos: "'", lt: "<", gt: ">", nbsp: " " };
      if (entity[0] === "#") {
        const point = Number.parseInt(entity.slice(entity[1]?.toLowerCase() === "x" ? 2 : 1), entity[1]?.toLowerCase() === "x" ? 16 : 10);
        return Number.isFinite(point) && point <= 0x10ffff ? String.fromCodePoint(point) : "";
      }
      return named[entity.toLowerCase()] || "";
    })
    .replace(/\s+/g, " ").trim().slice(0, 240);
}

function extract(html, url) {
  const tags = [...html.matchAll(/<meta\s+[^>]{0,1000}>/gi)];
  const meta = new Map();
  for (const [tag] of tags) {
    const attrs = Object.fromEntries([...tag.matchAll(/([\w:-]+)\s*=\s*(["'])(.*?)\2/gis)]
      .map(([, key, , value]) => [key.toLowerCase(), value]));
    const key = (attrs.property || attrs.name || "").toLowerCase();
    if (key && attrs.content && !meta.has(key)) meta.set(key, attrs.content);
  }
  const title = meta.get("og:title") || meta.get("twitter:title") ||
    html.match(/<title[^>]*>([\s\S]{0,500}?)<\/title>/i)?.[1];
  return {
    url: url.toString(),
    host: url.hostname.replace(/^www\./, ""),
    title: decode(title) || url.hostname,
    description: decode(meta.get("og:description") || meta.get("twitter:description") || meta.get("description")),
  };
}

async function fetchHtml(url, redirects = 0) {
  const addresses = await dns.resolve4(url.hostname);
  // Pin the connection to the resolved address. A second DNS lookup inside
  // the HTTP client would otherwise permit DNS rebinding to a private host.
  const address = addresses.find(publicAddress);
  if (!address) throw new Error("Preview host is unavailable");
  return new Promise((resolve, reject) => {
    const request = (url.protocol === "https:" ? https : http).get(url, {
      lookup: (_host, _options, callback) => callback(null, address, 4),
      headers: { Accept: "text/html", "User-Agent": "ConclaveLinkPreview/1.0" },
      timeout: 4000,
    }, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location && redirects < 2) {
        response.resume();
        const next = allowedUrl(new URL(response.headers.location, url).toString());
        if (!next) return reject(new Error("Preview redirect is unavailable"));
        fetchHtml(next, redirects + 1).then(resolve, reject);
        return;
      }
      if (response.statusCode !== 200 || !/^text\/html\b/i.test(response.headers["content-type"] || "")) {
        response.resume();
        return reject(new Error("Page preview unavailable"));
      }
      let bytes = 0;
      const chunks = [];
      response.on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes > MAX_HTML) {
          response.destroy();
          resolve({ html: Buffer.concat(chunks).toString("utf8"), url });
        } else chunks.push(chunk);
      });
      response.on("end", () => resolve({ html: Buffer.concat(chunks).toString("utf8"), url }));
      response.on("error", reject);
    });
    const deadline = setTimeout(
      () => request.destroy(new Error("Preview timed out")),
      5000,
    );
    request.on("close", () => clearTimeout(deadline));
    request.on("timeout", () => request.destroy(new Error("Preview timed out")));
    request.on("error", reject);
  });
}

async function linkPreview(input) {
  const url = allowedUrl(input);
  if (!url) return null;
  const key = url.toString();
  const existing = cache.get(key);
  if (existing && existing.expires > Date.now()) return existing.value;
  const result = await fetchHtml(url);
  const value = extract(result.html, result.url);
  if (cache.size > 500) cache.clear();
  cache.set(key, { value, expires: Date.now() + 30 * 60 * 1000 });
  return value;
}

module.exports = { linkPreview };
