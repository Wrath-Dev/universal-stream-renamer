/**************************************************************************
 * UNIVERSAL STREAM RENAMER — clean Real‑Debrid HTTP streams
 *   • /configure is back
 *   • absolute /proxy links for TV / Chromecast
 **************************************************************************/

const express                     = require("express");
const { addonBuilder, getRouter } = require("stremio-addon-sdk");
const http                        = require("http");

const PORT           = process.env.PORT || 10000;           // Render uses 10000
const DEFAULT_SOURCE = "https://torrentio.strem.fun/manifest.json";
const FALLBACK_MP4   = "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4";

/*──────────────── manifest ─────────────────*/
const manifest = {
  id        : "org.universal.stream.renamer",
  version   : "3.2.1",
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

/* One RD redirect for desktop / web */
async function resolveRD(u) {
  try {
    const r = await fetch(u, { method: "HEAD", redirect: "manual", timeout: 5000 });
    return r.headers.get("location") || u;
  } catch { return u; }
}

/*──────── stream handler ────────*/
builder.defineStreamHandler(async ({ type, id, config, headers }) => {
  const ua   = (headers?.["user-agent"] || "").toLowerCase();
  const isTV = ua.includes("android") || ua.includes("crkey") || ua.includes("smarttv");

  let src = config?.sourceAddonUrl || userConfigs.default || DEFAULT_SOURCE;
  if (config?.sourceAddonUrl) userConfigs.default = src;
  if (src.startsWith("stremio://")) src = src.replace("stremio://", "https://");

  const api = `${src.replace(/\/manifest\.json$/, "")}/stream/${type}/${id}.json`;

  /* fetch from Torrentio */
  let raw = [];
  try {
    const r = await fetch(api, { timeout: 8000 });
    if (r.ok) ({ streams: raw = [] } = await r.json());
  } catch (e) {
    console.error("⚠️ Torrentio fetch failed:", e.message);
  }

  const origin = `https://${headers?.host || process.env.RENDER_EXTERNAL_HOSTNAME}`;

  const streams = await Promise.all(raw.map(async (s, i) => {
    if (!s.url) return null;                       // keep only HTTP rows
    const final = !isTV ? await resolveRD(s.url) : s.url;
    return {
      url  : isTV ? `${origin}/proxy?u=${encodeURIComponent(final)}` : final,
      name : `[RD] Stream ${i + 1}`,
      title: `[RD] Stream ${i + 1}`
    };
  }));

  const clean = streams.filter(Boolean);
  if (isTV && clean.length === 0) {               // TV fallback
    clean.push({
      url : `${origin}/proxy?u=${encodeURIComponent(FALLBACK_MP4)}`,
      name: "Fallback MP4",
      title:"Fallback MP4"
    });
  }

  if (clean[0]) console.log("🟢 Handing to Stremio:", clean[0]);
  return { streams: clean };
});

/*──────────────── Express wiring ───────────────*/
const app = express();

/* same‑origin redirect for Chromecast / Android‑TV */
app.get("/proxy", (req, res) => {
  const u = req.query.u;
  if (!u) return res.status(400).send("missing u");
  res.redirect(302, u);
});

/* mount SDK router (provides /configure, /manifest.json, /stream/…) */
app.use("/", getRouter(builder.getInterface()));

/*──────────────── launch ───────────────*/
http.createServer(app).listen(PORT, () =>
  console.log(`🚀 add‑on listening on port ${PORT}`)
);
