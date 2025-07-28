const express = require("express");
const http = require("http");
const { addonBuilder, getRouter } = require("stremio-addon-sdk");
const AbortController = global.AbortController || require("abort-controller");
const fetch = global.fetch || require("node-fetch");

const PORT = process.env.PORT || 7000;
const DEFAULT_SOURCE = "https://torrentio.strem.fun/manifest.json";
const FALLBACK_MP4 = "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4";

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
  config: [{ key: "sourceAddonUrl", type: "text", title: "Source Add‑on Manifest URL" }]
};

const builder = addonBuilder(manifest);
const cache = new Map();
const TTL = 300000;
function put(key, val) {
  cache.set(key, val);
  setTimeout(() => cache.delete(key), TTL);
}

builder.defineStreamHandler(async ({ type, id, config, headers, query }) => {
  const ua = headers?.["user-agent"] || "";
  const isTV = /(exoplayer|stagefright|android\s?tv|crkey|googlecast|smarttv|appletv|roku)/i.test(ua) || !ua;
  const raw = query?.sourceAddonUrl || config?.sourceAddonUrl || global.lastSrc || DEFAULT_SOURCE;
  const src = decodeURIComponent(raw).replace("stremio://", "https://");
  global.lastSrc = src;

  const base = src.replace(/\/manifest\.json$/, "");
  const qStr = src.includes("?") ? src.slice(src.indexOf("?")) : "";
  const apiUrl = `${base}/stream/${type}/${encodeURIComponent(id)}.json${qStr}`;
  const cacheKey = `${type}:${id}:${qStr}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey);

  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), isTV ? 10000 : 4000);
  let res;
  try {
    res = await fetch(apiUrl, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch {
    return { streams: [] };
  }

  const { streams: upstream = [] } = await res.json();
  let streams = upstream.filter(s => s.url && s.url.includes("/resolve/realdebrid/"));
  if (isTV) streams = streams.filter(s => /\.mp4($|\?)/i.test(s.url));

  const mapped = streams.map((s, i) => {
    const url = s.url.replace(/^http:/, "https:");
    const clean = url.split("?")[0];
    const fname = clean.split("/").pop().toLowerCase();
    if (clean.includes("/static/videos/") || /^failed_/.test(fname) || fname.startsWith("blocked_") || fname.startsWith("limits_exceeded")) {
      return {
        name: "Fallback Video",
        title: "Fallback Video",
        url: FALLBACK_MP4,
        behaviorHints: {
          filename: "Fallback.mp4",
          notWebReady: false,
          container: "mp4",
          videoCodec: "h264",
          contentType: "video/mp4"
        }
      };
    }
    const m = clean.match(/\.([a-z0-9]+)$/i);
    const ext = m ? m[1].toLowerCase() : "mp4";
    const label = `[RD] Stream ${i+1}`;
    if (isTV) {
      return {
        name: label,
        title: label,
        url,
        behaviorHints: {
          filename: `${label.replace(/\s+/g, "_")}.mp4`,
          notWebReady: true,
          container: "mp4",
          videoCodec: "h264",
          audioCodec: "aac",
          contentType: "application/vnd.apple.mpegurl",
          bingeGroup: "renamerGroup"
        }
      };
    }
    return {
      name: label,
      title: label,
      url,
      behaviorHints: {
        filename: `${label.replace(/\s+/g, "_")}.${ext}`,
        notWebReady: false,
        container: ext,
        videoCodec: ext === "mkv" ? "h265" : "h264",
        contentType: `video/${ext}`,
        bingeGroup: "renamerGroup"
      }
    };
  });

  if (!mapped.length) {
    mapped.push({
      name: "Fallback MP4",
      title: "Fallback MP4",
      url: FALLBACK_MP4,
      behaviorHints: {
        filename: "Fallback.mp4",
        notWebReady: false,
        container: "mp4",
        videoCodec: "h264",
        contentType: "video/mp4"
      }
    });
  }

  const out = { streams: mapped };
  put(cacheKey, out);
  return out;
});

const app = express();
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", req.headers.origin || "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS,POST");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Accept,Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  if (req.query.sourceAddonUrl) global.lastSrc = req.query.sourceAddonUrl;
  next();
});
app.get("/", (_r, s) => s.redirect(302, "/configure"));
app.get(["/configure", "/configure/"], (r, s) => {
  const base = `${r.protocol}://${r.get("host")}/manifest.json`;
  const val = global.lastSrc || "";
  s.type("html").send(`
    <input id="src" style="width:100%;padding:.6rem" placeholder="${DEFAULT_SOURCE}" value="${val}">
    <button onclick="copy()">Copy Manifest URL</button>
    <a id="testLink" href="#" style="display:block;margin-top:1rem;">Test Manifest URL</a>
    <script>
      function copy() {
        const v = document.getElementById('src').value.trim();
        const u = v ? '${base}?sourceAddonUrl=' + encodeURIComponent(v) : '${base}';
        navigator.clipboard.writeText(u);
        document.getElementById('testLink').href = u;
      }
    </script>
  `);
});
app.get("/manifest.json", (_r, s, next) => next());
app.get("/health", (_r, s) => s.send("OK"));
app.use("/", getRouter(builder.getInterface()));
app.use((_r, s) => s.status(404).send("Not Found"));

http.createServer(app).listen(PORT, () => {
  console.log(`🚀 Add‑on listening on port ${PORT}`);
});