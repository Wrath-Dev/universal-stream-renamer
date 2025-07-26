/**************************************************************************
 *  UNIVERSAL STREAM RENAMER  –  v2.3.1
 *  Common‑JS, keeps original logic, adds /proxy and /configure
 **************************************************************************/

const express                     = require("express");   // ← NEW
const http                        = require("http");      // ← NEW
const { addonBuilder, getRouter } = require("stremio-addon-sdk");

const PORT           = process.env.PORT || 7001;
const DEFAULT_SOURCE = "https://torrentio.strem.fun/manifest.json";
const FALLBACK_MP4   = "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4";

/*─────────────────────────  manifest  ─────────────────────────*/
const manifest = {
  id          : "org.universal.stream.renamer",
  version     : "2.3.1",
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

/* 1️⃣  Chromecast‑safe redirect */
app.get("/proxy", (req, res) => {
  const u = req.query.u;
  if (!isAllowed(u)) return res.status(400).send("invalid target");
  res.redirect(302, u);
});

/* 2️⃣  Minimal configure page (re‑implements serveHTTP’s one) */
app.get("/configure", (req, res) => {
  const manifestUrl = `${req.protocol}://${req.get("host")}/manifest.json`;
  res.type("html").send(`
<!doctype html><meta charset=utf-8>
<title>Universal Stream Renamer – Configure</title>
<style>
 body{font-family:sans-serif;max-width:640px;margin:3rem auto;padding:1rem}
 input,button{font-size:1rem;padding:.6rem;width:100%;box-sizing:border-box;margin:.5rem 0}
</style>
<h1>Universal Stream Renamer</h1>
<p><strong>Add‑on manifest URL:</strong></p>
<input value="${manifestUrl}" readonly onclick="this.select()">
<p>
  <a href="stremio://${manifestUrl}" style="display:inline-block;padding:.8rem 1.2rem;background:#673ab7;color:#fff;text-decoration:none;border-radius:4px">
    Install&nbsp;in&nbsp;Stremio
  </a>
</p>
<p>If you need to override the <em>source&nbsp;add‑on</em> (e.g.&nbsp;Torrentio),
open Universal Stream Renamer in Stremio&nbsp;→&nbsp;Settings&nbsp;⚙ →&nbsp;“Source Add‑on&nbsp;URL”.</p>
`);
});

/* 3️⃣  Mount Stremio routes (manifest.json, /stream/…, etc.) */
app.use("/", getRouter(builder.getInterface()));

/* 4️⃣  Start server */
http.createServer(app).listen(PORT, () => {
  const external = process.env.RENDER_EXTERNAL_URL || `http://127.0.0.1:${PORT}`;
  console.log(`🚀 Universal Stream Renamer ready at: ${external}/manifest.json`);
});
