/**************************************************************************
 *  UNIVERSAL STREAM RENAMER — minimal, “clean” HTTP streams
 *  (put this in index.js or addon.js — nothing else needed)
 **************************************************************************/

const express                     = require("express");
const http                        = require("http");
const { addonBuilder, getRouter } = require("stremio-addon-sdk");

const PORT           = process.env.PORT || 10000;          // Render uses 10000
const DEFAULT_SOURCE = "https://torrentio.strem.fun/manifest.json";
const FALLBACK_MP4   = "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4";

/*──────────────── manifest ────────────────*/
const manifest = {
  id        : "org.universal.stream.renamer",
  version   : "3.2.0",
  name      : "Universal Stream Renamer",
  description: "Renames Torrentio streams; Chromecast‑safe same‑origin proxy.",
  resources : ["stream"],
  types     : ["movie", "series"],
  idPrefixes: ["tt"],
  catalogs  : [],
  config    : [
    { key: "sourceAddonUrl", type: "text",
      title: "Source Add‑on Manifest URL", required: false }
  ],
  behaviorHints: { configurable: true }
};

const builder     = new addonBuilder(manifest);
const userConfigs = Object.create(null);

/* helper: follow one RD redirect → final CDN URL (desktop only) */
async function resolveRD(u) {
  try {
    const r = await fetch(u, { method: "HEAD", redirect: "manual", timeout: 5000 });
    return r.headers.get("location") || u;
  } catch { return u; }
}

/*──────────────── stream handler ────────────────*/
builder.defineStreamHandler(async ({ type, id, config, headers }) => {
  const ua   = (headers?.["user-agent"] || "").toLowerCase();
  const isTV = ua.includes("android") || ua.includes("crkey") || ua.includes("smarttv");

  /* pick source manifest */
  let src = config?.sourceAddonUrl || userConfigs.default || DEFAULT_SOURCE;
  if (config?.sourceAddonUrl) userConfigs.default = src;
  if (src.startsWith("stremio://")) src = src.replace("stremio://", "https://");

  /* build Torrentio API URL */
  const api = `${src.replace(/\/manifest\.json$/, "")}/stream/${type}/${id}.json`;

  /* get streams from Torrentio */
  let raw = [];
  try {
    const r = await fetch(api, { timeout: 8000 });
    if (r.ok) ({ streams: raw = [] } = await r.json());
  } catch (e) {
    console.error("⚠️ Torrentio fetch failed:", e.message);
  }

  /* self‑origin for absolute proxy URLs */
  const origin = `https://${headers?.host || process.env.RENDER_EXTERNAL_HOSTNAME}`;

  /* map to “clean” HTTP streams */
  const streams = await Promise.all(raw.map(async (s, i) => {
    if (!s.url) return null;                // skip pure torrent rows

    /* desktop → follow one redirect for snappier start‑up            *
     * TV     → keep original RD link and serve via /proxy same‑origin */
    const final = !isTV ? await resolveRD(s.url) : s.url;
    const url   = isTV ? `${origin}/proxy?u=${encodeURIComponent(final)}` : final;

    return {
      url,
      name : `[RD] Stream ${i + 1}`,
      title: `[RD] Stream ${i + 1}`
    };
  }));

  /* remove nulls & fall back if needed */
  const clean = streams.filter(Boolean);
  if (isTV && clean.length === 0) {
    clean.push({
      url : `${origin}/proxy?u=${encodeURIComponent(FALLBACK_MP4)}`,
      name: "Fallback MP4",
      title:"Fallback MP4"
    });
  }

  /* debug: first object actually returned to Stremio */
  if (clean[0]) console.log("🟢 Handing to Stremio:", clean[0]);

  return { streams: clean };
});

/*──────────────── /proxy ────────────────*/
const app = express();
app.get("/proxy", (req, res) => {
  const u = req.query.u;
  if (!u) return res.status(400).send("missing u");
  res.redirect(302, u);
});

/* root → /configure (provided by SDK) */
app.get("/", (_req, res) => res.redirect("/configure"));
app.use("/", getRouter(builder.getInterface()));

/*──────────────── start ────────────────*/
http.createServer(app).listen(PORT, () =>
  console.log(`🚀 add‑on listening on port ${PORT}`)
);
