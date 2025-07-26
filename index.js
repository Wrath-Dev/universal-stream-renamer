/**************************************************************************
 *  UNIVERSAL STREAM RENAMER  –  v2.3.6
 *  • Keeps your original desktop logic and built‑in /configure page
 *  • Adds /proxy?u=… (302) so Android‑TV / Chromecast can play streams
 *  • Adds root “/ → /configure” redirect so opening the bare host works
 **************************************************************************/

const express                     = require("express");
const http                        = require("http");
const { addonBuilder, getRouter } = require("stremio-addon-sdk");

const DEFAULT_SOURCE = "https://torrentio.strem.fun/manifest.json";
const FALLBACK_MP4   = "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4";

/*────────────────────────── manifest ──────────────────────────*/
const manifest = {
  id          : "org.universal.stream.renamer",
  version     : "2.3.6",
  name        : "Universal Stream Renamer",
  description : "Renames Torrentio streams; adds same‑origin proxy for TV / Chromecast.",
  resources   : ["stream"],
  types       : ["movie", "series"],
  idPrefixes  : ["tt"],
  catalogs    : [],
  config      : [
    { key: "sourceAddonUrl", type: "text", title: "Source Add‑on Manifest URL", required: false }
  ],
  behaviorHints: { configurable: true }
};

const builder     = new addonBuilder(manifest);
const userConfigs = Object.create(null);

/* helper: follow one Real‑Debrid redirect and return final CDN URL */
async function resolveRD(rdUrl) {
  try {
    const res = await fetch(rdUrl, { method: "HEAD", redirect: "manual", timeout: 4000 });
    return res.headers.get("location") || rdUrl;
  } catch { return rdUrl; }
}

/*──────────────────── stream handler ────────────────────*/
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
    const r = await fetch(api, { timeout: 4000 });
    if (r.ok) {
      const { streams: raw = [] } = await r.json();

      streams = await Promise.all(
        raw.map(async (st, i) => {
          /* resolve RD redirect */
          if (st.url && st.url.includes("/resolve/realdebrid/")) {
            const final = await resolveRD(st.url);
            st.url = isTV ? `/proxy?u=${encodeURIComponent(final)}` : final;   // ← wrap only for TV
          }

          /* rename streams ONLY for desktop/web */
          if (!isTV) {
            const tag = st.name.match(/\[RD[^\]]*\]/)?.[0] || "[RD]";
            st = {
              ...st,
              name : `${tag} Stream ${i + 1}`,
              title: "Generic Stream",
              description: `Stream ${i + 1}`,
              behaviorHints: {
                ...(st.behaviorHints || {}),
                filename: `Stream_${i + 1}.mp4`
              }
            };
          }
          return st;
        })
      );
    }
  } catch (e) {
    console.error("⚠️ Torrentio fetch failed:", e.message);
  }

  /* fallback only when TV and list empty */
  if (isTV && streams.length === 0) {
    streams.push({
      name : "Fallback MP4",
      title: "Fallback Stream",
      url  : `/proxy?u=${encodeURIComponent(FALLBACK_MP4)}`,
      behaviorHints: { filename: "Fallback.mp4" }
    });
  }

  return { streams };
});

/*─────────────────── /proxy route ────────────────────*/
function isAllowed(u) {
  try {
    const { hostname, protocol } = new URL(u);
    const hostOK  = /(real-debrid|debrid-link|rdt|cache)/i.test(hostname);
    const protoOK = ["http:","https:"].includes(protocol);
    return hostOK && protoOK;
  } catch { return false; }
}

const app = express();

/* same‑origin 302 redirect for TV/Chromecast */
app.get("/proxy", (req, res) => {
  const u = req.query.u;
  if (!isAllowed(u)) return res.status(400).send("invalid target");
  res.redirect(302, u);
});

/* ⭐ restore root → /configure convenience */
app.get("/", (_req, res) => res.redirect("/configure"));

/* mount Stremio router – serves /configure, /manifest.json, /stream/… */
app.use("/", getRouter(builder.getInterface()));

/*──────────────────── start server ────────────────────*/
const PORT = process.env.PORT || 7001;
http.createServer(app).listen(PORT, () => {
  const external = process.env.RENDER_EXTERNAL_URL || `http://127.0.0.1:${PORT}`;
  console.log(`🚀 Universal Stream Renamer ready at: ${external}/manifest.json`);
});
