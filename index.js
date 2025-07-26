/**************************************************************************
 *  UNIVERSAL STREAM RENAMER  –  v2.3.0
 *  Common‑JS, keeps Stremio SDK’s /configure, adds Chromecast‑safe proxy
 **************************************************************************/

const express                     = require("express");
const http                        = require("http");
const { addonBuilder, getRouter } = require("stremio-addon-sdk");

const PORT           = process.env.PORT || 7001;
const DEFAULT_SOURCE = "https://torrentio.strem.fun/manifest.json";
const FALLBACK_MP4   = "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4";

/*─────────────────────────  manifest  ─────────────────────────*/
const manifest = {
  id          : "org.universal.stream.renamer",
  version     : "2.3.0",
  name        : "Universal Stream Renamer",
  description : "Renames Torrentio streams; Chromecast‑safe same‑origin proxy.",
  resources   : ["stream"],
  types       : ["movie", "series"],
  idPrefixes  : ["tt"],
  catalogs    : [],
  config      : [
    { key: "sourceAddonUrl",
      type: "text",
      title: "Source Add‑on Manifest URL", required: false }
  ],
  behaviorHints: { configurable: true }
};

const builder     = new addonBuilder(manifest);
const userConfigs = Object.create(null);

/*──────── helper: follow one RD redirect ────────*/
async function resolveRD(u) {
  try {
    const r = await fetch(u, { method: "HEAD", redirect: "manual", timeout: 4000 });
    return r.headers.get("location") || u;
  } catch { return u; }
}

/*─────────────  STREAM HANDLER  ─────────────*/
builder.defineStreamHandler(async ({ type, id, config, headers }) => {

  const ua   = (headers?.["user-agent"] || "").toLowerCase();
  const isTV = ua.includes("android") || ua.includes("crkey") || ua.includes("smarttv");

  let src = config?.sourceAddonUrl || userConfigs.default || DEFAULT_SOURCE;
  if (config?.sourceAddonUrl) userConfigs.default = src;
  if (src.startsWith("stremio://")) src = src.replace("stremio://", "https://");

  const api = `${src.replace(/\/manifest\.json$/, "")}/stream/${type}/${id}.json`;
  console.log("🔗", api);

  let streams = [];
  try {
    const resp = await fetch(api, { timeout: 4000 });
    if (resp.ok) {
      const { streams: raw = [] } = await resp.json();

      streams = await Promise.all(raw.map(async (s, i) => {

        /* --- resolve Real‑Debrid once --- */
        if (s.url?.includes("/resolve/realdebrid/")) {
          const final = await resolveRD(s.url);
          s.url = isTV ? `/proxy?u=${encodeURIComponent(final)}` : final;
        }

        /* --- desktop/web rename --- */
        if (!isTV) {
          const tag = s.name.match(/\[RD[^\]]*\]/)?.[0] || "[RD]";
          s = {
            ...s,
            name : `${tag} Stream ${i + 1}`,
            title: "Generic Stream",
            description: `Stream ${i + 1}`,
            behaviorHints: {
              ...(s.behaviorHints || {}),
              filename : `Stream_${i + 1}.mp4`
            }
          };
        }
        return s;
      }));
    }
  } catch (e) {
    console.error("⚠️ Torrentio fetch failed:", e.message);
  }

  /* TV fallback when list empty */
  if (isTV && streams.length === 0) {
    streams.push({
      name : "Fallback MP4",
      url  : `/proxy?u=${encodeURIComponent(FALLBACK_MP4)}`,
      behaviorHints: { filename: "Fallback.mp4" }
    });
  }

  return { streams };
});

/*───────────  SAME‑ORIGIN RD PROXY  ───────────*/
function isAllowed(u) {
  try {
    const { hostname, protocol } = new URL(u);
    const hostOK  = /(real-debrid|debrid-link|cache|rdt)/i.test(hostname);
    const protoOK = ["http:","https:"].includes(protocol);
    return hostOK && protoOK;
  } catch { return false; }
}

const app = express();

app.get("/proxy", (req, res) => {
  const u = req.query.u;
  if (!isAllowed(u)) return res.status(400).send("invalid target");
  res.redirect(302, u);
});

/* mount ALL Stremio add‑on routes (/configure, /manifest.json, /stream/…) */
app.use("/", getRouter(builder.getInterface()));

/* start server */
http.createServer(app).listen(PORT, () => {
  const external = process.env.RENDER_EXTERNAL_URL || `http://127.0.0.1:${PORT}`;
  console.log(`🚀 Universal Stream Renamer ready at: ${external}/manifest.json`);
});
