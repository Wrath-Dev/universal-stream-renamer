// index.js  (CommonJS)
const express = require("express");
const http    = require("http");          // still needed for createServer
const { addonBuilder, getRouter } =
      require("stremio-addon-sdk");

const PORT           = process.env.PORT || 7001;
const DEFAULT_SOURCE = process.env.SOURCE_MANIFEST    || "https://torrentio.strem.fun/manifest.json";
const FALLBACK_MP4   = process.env.FALLBACK_MP4       || "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4";

/*─────────────────────────  manifest  ─────────────────────────*/
const manifest = {
  id      : "org.universal.stream.renamer",
  version : "2.3.0",
  name    : "Universal Stream Renamer",
  description: "Renames Torrentio streams; Chromecast‑safe same‑origin proxy.",
  resources: ["stream"],
  types    : ["movie","series"],
  idPrefixes: ["tt"],
  catalogs : [],
  config   : [{ key:"sourceAddonUrl", type:"text", title:"Source Add‑on Manifest URL" }],
  behaviorHints:{ configurable:true }
};

const builder     = new addonBuilder(manifest);
const userConfigs = Object.create(null);

/*──────── helper: follow a single Real‑Debrid redirect ────────*/
async function resolveRD(u) {
  try {
    const res = await fetch(u, { method:"HEAD", redirect:"manual", timeout:4000 });
    return res.headers.get("location") || u;
  } catch { return u; }
}

/*──────────────────  stream handler  ─────────────────────────*/
builder.defineStreamHandler(async ({ type, id, config, headers }) => {
  const ua   = (headers?.["user-agent"] || "").toLowerCase();
  const isTV = ua.includes("android") || ua.includes("crkey") || ua.includes("smarttv");

  let src = config?.sourceAddonUrl || userConfigs.default || DEFAULT_SOURCE;
  if (config?.sourceAddonUrl) userConfigs.default = src;
  if (src.startsWith("stremio://")) src = src.replace("stremio://","https://");

  const api = `${src.replace(/\/manifest\.json$/,"")}/stream/${type}/${id}.json`;
  console.log("🔗", api);

  let streams = [];
  try {
    const r = await fetch(api, { timeout:4000 });
    if (r.ok) {
      const { streams: raw = [] } = await r.json();

      streams = await Promise.all(raw.map(async (s, i) => {
        /* handle RD */
        if (s.url?.includes("/resolve/realdebrid/")) {
          const final = await resolveRD(s.url);
          s.url = isTV ? `/proxy?u=${encodeURIComponent(final)}` : final;
        }

        /* desktop rename */
        if (!isTV) {
          const tag = s.name.match(/\[RD[^\]]*\]/)?.[0] || "[RD]";
          s = {
            ...s,
            name : `${tag} Stream ${i + 1}`,
            title: "Generic Stream",
            description: `Stream ${i + 1}`,
            behaviorHints:{ ...(s.behaviorHints||{}), filename:`Stream_${i+1}.mp4` }
          };
        }
        return s;
      }));
    }
  } catch (e) {
    console.error("⚠️ Torrentio fetch failed:", e.message);
  }

  /* add one dummy entry when nothing came back */
  if (isTV && streams.length === 0) {
    streams.push({
      name : "Fallback MP4",
      url  : `/proxy?u=${encodeURIComponent(FALLBACK_MP4)}`,
      behaviorHints:{ filename:"Fallback.mp4" }
    });
  }

  return { streams };
});

/*──────────────────  same‑origin proxy  ──────────────────────*/
function isAllowed(u) {
  try {
    const { hostname, protocol } = new URL(u);
    const hostOK  = /(real-debrid|debrid-link|rdt|cache)/i.test(hostname);
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

/* the add‑on interface (manifest, stream endpoint, etc.) */
app.use("/", getRouter(builder.getInterface()));

/* start server */
http.createServer(app).listen(PORT, () => {
  console.log(`🚀  Add‑on ready at http://127.0.0.1:${PORT}/manifest.json`);
});
