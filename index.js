const express = require("express");
const http = require("http");
const { addonBuilder, serveHTTP } = require("stremio-addon-sdk");
const AbortController = global.AbortController || require("abort-controller");
const fetch = global.fetch || require("node-fetch");

const PORT = process.env.PORT; // Rely on Render's assigned port
const DEFAULT_SOURCE = "https://torrentio.strem.fun/manifest.json";
const FALLBACK_MP4 = "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4";

/* ───────── Manifest ───────── */
const manifest = {
  id: "org.universal.stream.renamer",
  version: "4.3.20",
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

  const rawSrc = query?.sourceAddonUrl || config?.sourceAddonUrl || global.lastSrc || DEFAULT_SOURCE;
  const src = decodeURIComponent(rawSrc).replace("stremio://", "https://");
  global.lastSrc = src;
  console.log(`Source URL: ${src}`);

  const base = src.replace(/\/manifest\.json$/, "");
  const qStr = src.includes("?") ? src.slice(src.indexOf("?")) : "";
  const api = `${base}/stream/${type}/${id}.json${qStr}`;
  console.log(`Fetching: ${api}`);

  const cKey = `${type}:${id}:${qStr}`;
  if (cache.has(cKey)) {
    console.log(`Cache hit for ${cKey}`);
    return cache.get(cKey);
  }

  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), isTV ? 15000 : 4000); // Increased TV timeout to 15s
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

  (json.streams || []).slice(0, 3).forEach((s, i) => {
    console.log(`Stream #${i + 1}:`, JSON.stringify({ url: s.url, infoHash: s.infoHash }, null, 2));
  });

  const streams = (json.streams || []).filter((s) => s.url && s.url.includes("/resolve/realdebrid/"));
  console.log(`Direct RD links: ${streams.length}`);

  let idx = 1;
  const mapped = streams.map((s) => {
    const label = `[RD] Stream ${idx++}`;
    const urlParts = s.url.split("/").pop().split(".");
    const extension = urlParts.length > 1 ? `.${urlParts.pop().toLowerCase()}` : ".mkv"; // Default to .mkv if no extension
    return {
      name: label,
      title: label,
      url: s.url.replace(/^http:/, "https:"),
      behaviorHints: {
        filename: `${label.replace(/\s+/g, "_")}${extension}`,
        notWebReady: false,
        videoCodec: "h265",
        container: extension.replace(".", ""),
        contentType: `video/${extension.replace(".", "")}`, // Add contentType hint
        bingeGroup: "renamerGroup",
      },
    };
  });

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
  } else {
    // Add H.264 fallback for TV devices
    if (isTV) {
      mapped.push({
        name: "Fallback H.264",
        url: FALLBACK_MP4,
        behaviorHints: {
          filename: "Fallback_H264.mp4",
          notWebReady: false,
          videoCodec: "h264",
          container: "mp4",
          contentType: "video/mp4",
        },
      });
    }
  }

  console.log(`Final streams: ${mapped.length}`, JSON.stringify(mapped.slice(0, 3), null, 2));
  const out = { streams: mapped };
  put(cKey, out);
  console.log(`Returning to Stremio:`, JSON.stringify(out, null, 2));
  return out;
});

/* ───────── Express Setup ───────── */
const app = express();

app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl} - Headers: ${JSON.stringify(req.headers)}`);
  res.setHeader("Access-Control-Allow-Origin", req.headers.origin || "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS, POST");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept, Authorization");
  res.setHeader("Access-Control-Max-Age", "86400");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.query.sourceAddonUrl) global.lastSrc = req.query.sourceAddonUrl;
  next();
});

app.get("/", (req, res) => {
  console.log(`Serving root path`);
  res.redirect(302, "/configure");
});

app.use("/", serveHTTP(builder.getInterface()));

app.get("/health", (req, res) => {
  console.log(`[${new Date().toISOString()}] Health check`);
  res.status(200).send("OK");
});

app.use((req, res) => {
  console.log(`404: ${req.method} ${req.originalUrl}`);
  res.status(404).send("Not Found");
});

http.createServer(app).listen(PORT, () => {
  console.log(`🚀 Add-on listening on port ${PORT}`);
  console.log(`Try accessing: http://localhost:${PORT}/configure (local) or https://stremio-universal-stream-renamer.onrender.com/configure (Render)`);
});