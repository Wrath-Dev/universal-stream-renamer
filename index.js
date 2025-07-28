// index.js
const express       = require("express");
const http          = require("http");
const { addonBuilder, getRouter } = require("stremio-addon-sdk");
const AbortController = global.AbortController || require("abort-controller");
const fetch         = global.fetch || require("node-fetch");

const PORT           = process.env.PORT || 7000;
const DEFAULT_SOURCE = "https://torrentio.strem.fun/manifest.json";
const FALLBACK_MP4   = "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4";

// ── Manifest & Builder ───────────────────────────────────────────────────────
const manifest = {
  id:           "org.universal.stream.renamer",
  version:      "4.3.19",
  name:         "Universal Stream Renamer",
  description:  "Renames Real‑Debrid direct links for Stremio (Chromecast & desktop).",
  resources:    ["stream"],
  types:        ["movie","series"],
  idPrefixes:   ["tt"],
  catalogs:     [],
  behaviorHints:{ configurable: true },
  config:       [{ key: "sourceAddonUrl", type: "text", title: "Source Add‑on Manifest URL" }],
};
const builder = addonBuilder(manifest);

// ── In‑Memory Cache ─────────────────────────────────────────────────────────
const cache = new Map();
const TTL   = 5 * 60 * 1000;
function put(key, val){
  cache.set(key,val);
  setTimeout(()=>cache.delete(key), TTL);
}

// ── Stream Handler ──────────────────────────────────────────────────────────
builder.defineStreamHandler(async ({ type, id, config, headers, query }) => {
  const uaRaw = headers?.["user-agent"] || "";
  const uaL   = uaRaw.toLowerCase();
  const isTV  = /(exoplayer|stagefright|dalvik|android tv|shield|bravia|crkey|smarttv)/i.test(uaL) || !uaRaw;
  console.log(`\n[${new Date().toISOString()}] Stream request: type=${type}, id=${id}, isTV=${isTV}`);

  // Determine source manifest URL
  const rawSrc = query?.sourceAddonUrl || config?.sourceAddonUrl || global.lastSrc || DEFAULT_SOURCE;
  const src    = decodeURIComponent(rawSrc).replace("stremio://","https://");
  global.lastSrc = src;
  console.log(`Using source manifest: ${src}`);

  // Build the API URL
  const base   = src.replace(/\/manifest\.json$/,"");
  const qStr   = src.includes("?") ? src.slice(src.indexOf("?")) : "";
  const apiUrl = `${base}/stream/${type}/${id}.json${qStr}`;
  console.log(`Fetching streams from: ${apiUrl}`);

  // Check cache
  const cacheKey = `${type}:${id}:${qStr}`;
  if (cache.has(cacheKey)){
    console.log("→ Cache hit");
    return cache.get(cacheKey);
  }

  // Fetch with timeout
  const timeoutMs = isTV ? 10_000 : 4_000;
  const ctrl      = new AbortController();
  setTimeout(()=>ctrl.abort(), timeoutMs);

  let res;
  try {
    res = await fetch(apiUrl, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch(err) {
    console.error("Fetch error:", err.message);
    return { streams: [] };
  }

  const json = await res.json();
  console.log(`→ Fetched ${json.streams?.length||0} streams`);

  // Print out upstream container/codecs
  (json.streams||[]).slice(0,5).forEach((s,i) => {
    console.log(`  Stream[${i}]: container=${s.container}, videoCodec=${s.videoCodec}, audioCodec=${s.audioCodec}`);
  });

  // Filter for Real‑Debrid links
  let streams = (json.streams||[]).filter(s => s.url && s.url.includes("/resolve/realdebrid/"));
  console.log(`→ Found ${streams.length} RD links`);

  // Map to Stremio streams
  const mapped = streams.map((s,i) => {
    const label = `[RD] Stream ${i+1}`;
    if (isTV) {
      // Chromecast/TV: transcode via HLS
      return {
        name:  label,
        title: label,
        url:   s.url.replace(/^http:/,"https:"),
        behaviorHints: {
          filename:    `${label.replace(/\s+/g,"_")}.mp4`,
          notWebReady: true,                 // trigger FFmpeg→HLS
          container:   "mp4",
          videoCodec:  "h264",
          audioCodec:  "aac",
          contentType: "application/vnd.apple.mpegurl",
          bingeGroup:  "renamerGroup",
        },
      };
    }

    // Desktop: raw container/codec
    let ext       = ".mkv";
    let container = "mkv";
    let vcodec    = "h265";
    if (s.container) {
      container = s.container;
      ext       = `.${s.container}`;
      vcodec    = s.videoCodec || vcodec;
    }

    return {
      name:  label,
      title: label,
      url:   s.url.replace(/^http:/,"https:"),
      behaviorHints: {
        filename:    `${label.replace(/\s+/g,"_")}${ext}`,
        notWebReady: false,
        container,
        videoCodec: vcodec,
        contentType:`video/${container}`,
        bingeGroup: "renamerGroup",
      },
    };
  });

  // Fallback if none
  if (!mapped.length) {
    console.warn("No streams → using fallback MP4");
    mapped.push({
      name:  "Fallback MP4",
      title: "Fallback MP4",
      url:   FALLBACK_MP4,
      behaviorHints: {
        filename:    "Fallback.mp4",
        notWebReady: false,
        container:   "mp4",
        videoCodec:  "h264",
        contentType: "video/mp4",
      },
    });
  }

  const out = { streams: mapped };
  put(cacheKey, out);
  console.log(`→ Returning ${mapped.length} streams\n`);
  return out;
});

// ── Express Setup ─────────────────────────────────────────────────────────────
const app = express();
app.use((req,res,next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl}`);
  res.setHeader("Access-Control-Allow-Origin", req.headers.origin||"*");
  res.setHeader("Access-Control-Allow-Methods","GET,OPTIONS,POST");
  res.setHeader("Access-Control-Allow-Headers","Content-Type,Accept,Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  if (req.query.sourceAddonUrl) global.lastSrc = req.query.sourceAddonUrl;
  next();
});
app.get("/",        (r,s) => s.redirect(302, "/configure"));
app.get(["/configure","/configure/"], (r,s) => {
  const base = `${r.protocol}://${r.get("host")}/manifest.json`;
  const val  = global.lastSrc||"";
  s.type("html").send(`
    <input id="src" style="width:100%;padding:.6rem" placeholder="${DEFAULT_SOURCE}" value="${val}">
    <button onclick="copy()">Copy Manifest URL</button>
    <a id="testLink" href="#" style="display:block;margin-top:1rem;">Test Manifest URL</a>
    <script>
      function copy(){
        const v = document.getElementById('src').value.trim();
        const url = v
          ? '${base}?sourceAddonUrl='+encodeURIComponent(v)
          : '${base}';
        navigator.clipboard.writeText(url);
        document.getElementById('testLink').href = url;
      }
    </script>
  `);
});
app.get("/manifest.json", (r,s,n) => { console.log("Serving manifest.json"); n(); });
app.get("/health", (_r,s) => s.send("OK"));
app.use("/", getRouter(builder.getInterface()));
app.use((r,s) => { s.status(404).send("Not Found"); });

http.createServer(app).listen(PORT, () => {
  console.log(`🚀 Add‑on listening on port ${PORT}`);
  console.log(`→ Local configure: http://localhost:${PORT}/configure`);
  console.log(`→ Remote: https://<your-domain>/configure`);
});