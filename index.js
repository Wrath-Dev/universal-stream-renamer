// index.js
const express = require("express");
const http = require("http");
const { addonBuilder, getRouter } = require("stremio-addon-sdk");
const AbortController = global.AbortController || require("abort-controller");
const fetch = global.fetch || require("node-fetch");

const PORT = process.env.PORT || 7000;
const DEFAULT_SOURCE = "https://torrentio.strem.fun/manifest.json";
const FALLBACK_MP4 = "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4";

////////////////////////////////////////////////////////////////////////////////
// ──────────────── Manifest & Builder ────────────────
////////////////////////////////////////////////////////////////////////////////
const manifest = {
  id: "org.universal.stream.renamer",
  version: "4.3.19",
  name: "Universal Stream Renamer",
  description: "Renames Real‑Debrid direct links for Stremio (Chromecast & desktop).",
  resources: ["stream"],
  types: ["movie", "series"],
  idPrefixes: ["tt"],
  catalogs: [],
  behaviorHints: { configurable: true },
  config: [{ key: "sourceAddonUrl", type: "text", title: "Source Add‑on Manifest URL" }],
};
const builder = addonBuilder(manifest);

////////////////////////////////////////////////////////////////////////////////
// ──────────────── Simple In‑Memory Cache ────────────────
////////////////////////////////////////////////////////////////////////////////
const cache = new Map();
const TTL = 300_000;
function put(key, value) {
  cache.set(key, value);
  setTimeout(() => cache.delete(key), TTL);
}

////////////////////////////////////////////////////////////////////////////////
// ──────────────── Stream Handler ────────────────
////////////////////////////////////////////////////////////////////////////////
builder.defineStreamHandler(async ({ type, id, config, headers, query }) => {
  const uaRaw = headers?.["user-agent"] || "";
  const uaL = uaRaw.toLowerCase();
  // Chromecast / TV UA detection
  const isTV = /(exoplayer|stagefright|dalvik|android tv|shield|bravia|crkey|smarttv)/i.test(uaL) || !uaRaw;
  console.log(`[${new Date().toISOString()}] Stream request: type=${type}, id=${id}, isTV=${isTV}`);

  // Determine source manifest URL
  const rawSrc = query?.sourceAddonUrl || config?.sourceAddonUrl || global.lastSrc || DEFAULT_SOURCE;
  const src = decodeURIComponent(rawSrc).replace("stremio://", "https://");
  global.lastSrc = src;
  console.log(`Source manifest URL: ${src}`);

  // Build API endpoint
  const base = src.replace(/\/manifest\.json$/, "");
  const qStr = src.includes("?") ? src.slice(src.indexOf("?")) : "";
  const apiUrl = `${base}/stream/${type}/${id}.json${qStr}`;
  console.log(`Fetching streams from: ${apiUrl}`);

  // Cache key
  const cacheKey = `${type}:${id}:${qStr}`;
  if (cache.has(cacheKey)) {
    console.log(`Cache hit for ${cacheKey}`);
    return cache.get(cacheKey);
  }

  // Fetch with timeout
  const timeout = isTV ? 10000 : 4000;
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), timeout);

  let fetched;
  try {
    fetched = await fetch(apiUrl, { signal: ctrl.signal });
    if (!fetched.ok) throw new Error(`HTTP ${fetched.status} ${fetched.statusText}`);
  } catch (err) {
    console.error(`Fetch error: ${err.message}`);
    return { streams: [] };
  }

  const json = await fetched.json();
  console.log(`Fetched ${json.streams?.length || 0} stream entries`);

  // Filter Real‑Debrid links
  let streams = (json.streams || []).filter(s => s.url && s.url.includes("/resolve/realdebrid/"));
  console.log(`Found ${streams.length} RD links`);

  // If Chromecast/TV, only keep .mp4
  if (isTV) {
    streams = streams.filter(s => /\.mp4($|\?)/i.test(s.url));
    console.log(`Filtered to ${streams.length} .mp4 links for TV`);
  }

  // Map to Stremio format
  const mapped = streams.map((s, idx) => {
    const label = `[RD] Stream ${idx + 1}`;
    let extension = ".mp4";
    let container = "mp4";
    let videoCodec = "h264";

    if (!isTV) {
      const parts = s.url.split("/").pop().split(".");
      if (parts.length > 1) {
        extension = "." + parts.pop().toLowerCase();
        container = extension.slice(1);
        // default to h264 but allow h265 for mkv
        videoCodec = container === "mkv" ? "h265" : "h264";
      }
    }

    return {
      name: label,
      title: label,
      url: s.url.replace(/^http:/, "https:"),
      behaviorHints: {
        filename: `${label.replace(/\s+/g, "_")}${extension}`,
        notWebReady: false,
        container,
        videoCodec,
        contentType: `video/${container}`,
        bingeGroup: "renamerGroup",
      },
    };
  });

  // Fallback if nothing valid
  if (mapped.length === 0) {
    console.warn("No compatible streams found, using fallback MP4");
    mapped.push({
      name: "Fallback MP4",
      title: "Fallback MP4",
      url: FALLBACK_MP4,
      behaviorHints: {
        filename: "Fallback.mp4",
        notWebReady: false,
        container: "mp4",
        videoCodec: "h264",
        contentType: "video/mp4",
      },
    });
  }

  const result = { streams: mapped };
  put(cacheKey, result);

  console.log(`Returning ${mapped.length} streams`);
  return result;
});

////////////////////////////////////////////////////////////////////////////////
// ──────────────── Express App ────────────────
////////////////////////////////////////////////////////////////////////////////
const app = express();

// CORS & logging
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl}`);
  res.setHeader("Access-Control-Allow-Origin", req.headers.origin || "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS, POST");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept, Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  if (req.query.sourceAddonUrl) global.lastSrc = req.query.sourceAddonUrl;
  next();
});

// Root → configure
app.get("/", (req, res) => res.redirect(302, "/configure"));

// Simple configure page
app.get(["/configure", "/configure/"], (req, res) => {
  const base = `${req.protocol}://${req.get("host")}/manifest.json`;
  const srcValue = global.lastSrc || "";
  res.type("html").send(`
    <input id="src" style="width:100%;padding:.6rem" placeholder="${DEFAULT_SOURCE}" value="${srcValue}">
    <button onclick="copy()">Copy Manifest URL</button>
    <a id="testLink" href="#" style="display:block;margin-top:1rem;">Test Manifest URL</a>
    <script>
      function copy() {
        const v = document.getElementById('src').value.trim();
        const url = v ? '${base}?sourceAddonUrl=' + encodeURIComponent(v) : '${base}';
        document.getElementById('testLink').href = url;
        navigator.clipboard.writeText(url);
      }
    </script>
  `);
});

// Serve manifest.json
app.get("/manifest.json", (req, res, next) => {
  console.log("Serving manifest.json");
  next();
});

// Health check
app.get("/health", (req, res) => res.send("OK"));

// Stremio router
app.use("/", getRouter(builder.getInterface()));

// 404 handler
app.use((req, res) => {
  console.warn(`404 at ${req.method} ${req.originalUrl}`);
  res.status(404).send("Not Found");
});

// Start server
http.createServer(app).listen(PORT, () => {
  console.log(`🚀 Add‑on listening on port ${PORT}`);
  console.log(`→ Local configure: http://localhost:${PORT}/configure`);
  console.log(`→ Remote configure: https://<your-domain>/configure`);
});
