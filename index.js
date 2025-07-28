const express = require("express");
const http = require("http");
const { addonBuilder, getRouter } = require("stremio-addon-sdk");
const AbortController = global.AbortController || require("abort-controller");
const fetch = global.fetch || require("node-fetch");

const PORT = process.env.PORT || 10000;
const DEFAULT_SOURCE = "https://torrentio.strem.fun/manifest.json";
const FALLBACK_MP4 = "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4";

/* ───────── Manifest ───────── */
const manifest = {
  id: "org.universal.stream.renamer",
  version: "4.3.15",
  name: "Universal Stream Renamer",
  description: "Renames Real-Debrid direct links for Stremio (Chromecast & desktop).",
  resources: ["stream"],
  types: ["movie", "series"],
  idPrefixes: ["tt"],
  catalogs: [],
  behaviorHints: { configurable: true },
  config: [{ key: "sourceAddonUrl", type: "text", title: "Source Add-on Manifest URL" }],
};

const builder = addonBuilder(manifest);

/* ───────── Cache ───────── */
const cache = new Map();
const TTL = 300_000;
const put = (k, v) => {
  cache.set(k, v);
  setTimeout(() => cache.delete(k), TTL);
};

/* ───────── Stream Handler ───────── */
builder.defineStreamHandler(async ({ type, id, config, headers, query }) => {
  const uaRaw = headers?.["user-agent"] || "";
  const uaL = uaRaw.toLowerCase();
  const isTV = /(exoplayer|stagefright|dalvik|android tv|shield|bravia|crkey|smarttv)/i.test(uaL) || !uaRaw;
  console.log(`[${new Date().toISOString()}] Stream request: type=${type}, id=${id}, UA=${uaRaw || "<none>"}, isTV=${isTV}`);
  console.log(`Config: ${JSON.stringify(config || {}, null, 2)}`);
  console.log(`Query: ${JSON.stringify(query || {}, null, 2)}`);

  // Use query.sourceAddonUrl as primary source
  const rawSrc = query?.sourceAddonUrl || config?.sourceAddonUrl || global.lastSrc || DEFAULT_SOURCE;
  const src = decodeURIComponent(rawSrc).replace("stremio://", "https://");
  global.lastSrc = src;
  console.log(`Source URL: ${src}`);

  // Build stream endpoint
  const base = src.replace(/\/manifest\.json$/, "");
  const qStr = src.includes("?") ? src.slice(src.indexOf("?")) : "";
  const api = `${base}/stream/${type}/${id}.json${qStr}`;
  console.log(`Fetching: ${api}`);

  const cKey = `${type}:${id}:${qStr}`;
  if (cache.has(cKey)) {
    console.log(`Cache hit for ${cKey}`);
    return cache.get(cKey);
  }

  // Fetch Torrentio
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), isTV ? 5000 : 4000);
  let res;
  try {
    res = await fetch(api, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  } catch (e) {
    console.error(`Fetch error: ${e.message}`);
    return { streams: [] };
  }

  const json = await res.json();
  console.log(`Fetched streams: ${json.streams?.length ?? 0}`);

  // Log first few streams
  (json.streams || []).slice(0, 3).forEach((s, i) => {
    console.log(`Stream #${i + 1}:`, JSON.stringify({ url: s.url, infoHash: s.infoHash }, null, 2));
  });

  // Filter Real-Debrid direct links
  const streams = (json.streams || []).filter((s) => s.url && s.url.includes("/resolve/realdebrid/"));
  console.log(`Direct RD links: ${streams.length}`);

  // Map and rename streams
  let idx = 1;
  const mapped = streams.map((s) => {
    const label = `[RD] Stream ${idx++}`;
    return {
      name: label,
      title: label,
      url: s.url.replace(/^http:/, "https:"), // Direct RD URL
      behaviorHints: {
        filename: `${label.replace(/\s+/g, "_")}.mp4`,
        notWebReady: false,
        videoCodec: "h265", // Common codec for RD streams
        container: "mkv", // Match expected file type
      },
    };
  });

  // Add fallback if no streams
  if (mapped.length === 0) {
    console.log("No streams found, adding fallback MP4");
    mapped.push({
      name: "Fallback MP4",
      url: FALLBACK_MP4,
      behaviorHints: {
        filename: "Fallback.mp4",
        notWebReady: false,
        contentType: "video/mp4",
      },
    });
  }

  console.log(`Final streams: ${mapped.length}`, JSON.stringify(mapped.slice(0, 3), null, 2));
  const out = { streams: mapped };
  put(cKey, out);
  console.log(`Returning to Stremio:`, JSON.stringify(out, null, 2));
  return out;
});

/* ───────── Express Setup ───────── */
const app = express();

// Log all requests and store sourceAddonUrl
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl} - Headers: ${JSON.stringify(req.headers)}`);
  if (req.query.sourceAddonUrl) global.lastSrc = req.query.sourceAddonUrl;
  // Add CORS headers
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  next();
});

// Handle root path for Render
app.get("/", (req, res) => {
  console.log(`Serving root path`);
  res.redirect(302, "/configure");
});

// Handle /configure
app.get(["/configure", "/configure/"], (req, res) => {
  const base = `${req.protocol}://${req.get("host")}/manifest.json`;
  console.log(`Serving /configure, base URL: ${base}`);
  res.type("html").send(`
    <input id="src" style="width:100%;padding:.6rem" placeholder="${DEFAULT_SOURCE}" value="${global.lastSrc || ""}">
    <button onclick="copy()">Copy manifest URL</button>
    <script>
      function copy() {
        const v = document.getElementById('src').value.trim();
        const url = v ? '${base}?sourceAddonUrl=' + encodeURIComponent(v) : '${base}';
        navigator.clipboard.writeText(url).then(() => alert('Copied:\\n' + url));
      }
    </script>
  `);
});

// Log manifest requests
app.get("/manifest.json", (req, res, next) => {
  console.log(`Serving /manifest.json, query: ${JSON.stringify(req.query, null, 2)}`);
  next();
});

// Mount Stremio router
app.use("/", getRouter(builder.getInterface()));

// Fallback for debugging
app.use((req, res) => {
  console.log(`404: ${req.method} ${req.originalUrl}`);
  res.status(404).send("Not Found");
});

// Start server
http.createServer(app).listen(PORT, () => {
  console.log(`🚀 Add-on listening on port ${PORT}`);
  console.log(`Try accessing: http://localhost:${PORT}/configure (local) or https://stremio-universal-stream-renamer.onrender.com/configure (Render)`);
});