/* ───────────  imports (Common-JS)  ─────────── */
const express = require("express");
const http    = require("http");
const { addonBuilder, getRouter } = require("stremio-addon-sdk");

/* Node ≥18 has global fetch; fallback for older envs */
const fetchFn = global.fetch || ((...a) =>
  import("node-fetch").then(({ default: d }) => d(...a)));

/* ───────────  constants  ─────────── */
const PORT           = process.env.PORT || 7000;
const DEFAULT_SOURCE = "https://torrentio.strem.fun/manifest.json";
const FALLBACK_MP4   = "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4";

/* ───────────  manifest  ─────────── */
const manifest = {
  id          : "org.universal.stream.renamer",
  version     : "3.1.0",
  name        : "Universal Stream Renamer",
  description : "Renames Torrentio streams; TV-safe same-origin proxy for Real-Debrid.",
  resources   : ["stream"],
  types       : ["movie", "series"],
  idPrefixes  : ["tt"],
  catalogs    : [],
  config: [
    { key: "sourceAddonUrl", type: "text", title: "Source Add-on Manifest URL", required: false }
  ],
  behaviorHints: { configurable: true }
};

const builder     = new addonBuilder(manifest);
const userConfigs = {};

/* ───────────  helper: resolve first redirect  ─────────── */
async function resolveRD(url) {
  try {
    const r = await fetchFn(url, { method: "HEAD", redirect: "manual", timeout: 5000 });
    return r.headers.get("location") || url;
  } catch { return url; }
}

/* ───────────  STREAM HANDLER  ─────────── */
builder.defineStreamHandler(async ({ type, id, config, headers }) => {
  const ua   = (headers?.["user-agent"] || "").toLowerCase();
  const isTV = ua.includes("android") || ua.includes("crkey") || ua.includes("smarttv");

  /* pick source manifest */
  let src = config?.sourceAddonUrl || userConfigs.default || DEFAULT_SOURCE;
  if (config?.sourceAddonUrl) userConfigs.default = config.sourceAddonUrl;
  if (src.startsWith("stremio://")) src = src.replace("stremio://", "https://");

  const tURL = `${src.replace(/\/manifest\.json$/, "")}/stream/${type}/${id}.json`;
  console.log("🔗", tURL);

  let streams = [];
  try {
    const r = await fetchFn(tURL, { timeout: 5000 });
    if (r.ok) {
      const { streams: raw = [] } = await r.json();

      streams = await Promise.all(
        raw.map(async (st, i) => {
          /* 1️⃣ resolve RD redirect then wrap in /proxy */
          if (st.url?.includes("/resolve/realdebrid/")) {
            const cdn = await resolveRD(st.url);
            st.url = `/proxy?u=${encodeURIComponent(cdn)}`; // same host
          }

          /* 2️⃣ generic but unique name for **all** clients */
          const rdTag = st.name.match(/\[RD[^\]]*\]/)?.[0] || "[RD]";
          return {
            ...st,
            name : `${rdTag} Stream ${i + 1}`,
            title: "Generic Stream",
            description: `Stream ${i + 1}`,
            behaviorHints: {
              ...(st.behaviorHints || {}),
              filename: `Stream_${i + 1}.mp4`
            }
          };
        })
      );
    }
  } catch (e) {
    console.error("Torrentio fetch failed:", e.message);
  }

  /* fallback MP4 when nothing else on TV */
  if (isTV && streams.length === 0) {
    streams.push({
      name : "[RD] Stream 1",
      url  : FALLBACK_MP4,
      behaviorHints:{ filename:"Fallback.mp4" }
    });
  }

  return { streams };
});

/* ───────────  EXPRESS SERVER + proxy  ─────────── */
const app    = express();
const server = http.createServer(app);

/* same-origin redirect */
app.get("/proxy", (req, res) => {
  const u = req.query.u;
  if (!u) return res.status(400).send("missing u");
  res.redirect(302, u);
});

/* mount Stremio via Express router */
app.use("/", getRouter(builder.getInterface()));

server.listen(PORT, () => {
  const publicURL = process.env.RENDER_EXTERNAL_URL || `http://127.0.0.1:${PORT}`;
  console.log("🚀 Universal Stream Renamer:", `${publicURL}/manifest.json`);
});
