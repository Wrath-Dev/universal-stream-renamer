/*  universal‑stream‑renamer  v2.3.0  – CommonJS, Express wrapper  */

const express       = require("express");
const http          = require("http");
const { addonBuilder, getRouter } = require("stremio-addon-sdk");

const PORT           = process.env.PORT || 7001;
const DEFAULT_SOURCE = process.env.SOURCE_MANIFEST ||
                       "https://torrentio.strem.fun/manifest.json";
const FALLBACK_MP4   = "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4";

/*───────────────  add‑on manifest  ───────────────*/
const manifest = {
  id: "org.universal.stream.renamer",
  version: "2.3.0",
  name: "Universal Stream Renamer",
  description: "Renames Torrentio streams; Chromecast‑safe same‑origin proxy.",
  resources: ["stream"],
  types: ["movie", "series"],
  idPrefixes: ["tt"],
  catalogs: [],
  config: [
    { key: "sourceAddonUrl", type: "text", title: "Source Add‑on Manifest URL" }
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

        /* --- desktop renaming --- */
        if (!isTV) {
          const tag = s.name.match(/\[RD[^\]]*\]/)?.[0] || "[RD]";
          s = {
            ...s,
            name : `${tag} Stream ${i + 1}`,
            title: "Generic Stream",
            description: `Stream ${i + 1}`,
            behaviorHints: { ...(s.behaviorHints || {}), filename:`Stream_${i+1}.mp4` }
          };
        }
        return s;
      }));
    }
  } catch (e) {
    console.error("⚠️ Torrentio fetch failed:", e.message);
  }

  /* TV fallback when list empty */
  if (isTV && streams.length === 0) {
    streams.push({
      name : "Fallback MP4",
      url  : `/proxy?u=${encodeURIComponent(FALLBACK_MP4)}`,
      behaviorHints:{ filename: "Fallback.mp4" }
    });
  }

  return { streams };
});

/*───────────  SAME‑ORIGIN RD PROXY  ───────────*/
function isAllowed(u) {
  try {
    const { hostname, protocol } = new URL(u);
    const hostOK  = /(real-debrid|debrid-link|cache|rdt)/i.test(hostname);
    const protoOK = ["http:", "https:"].includes(protocol);
    return hostOK && protoOK;
  } catch { return false; }
}

const app = express();

app.get("/proxy", (req, res) => {
  const u = req.query.u;
  if (!isAllowed(u)) return res.status(400).send("invalid target");
  res.redirect(302, u);
});

/*────────────  SIMPLE /configure PAGE  ────────────*/
app.get("/configure", (_req, res) => {
  res.type("html").send(`
<!doctype html><meta charset=utf-8>
<title>Universal Stream Renamer – Configure</title>
<style>
 body{font-family:sans-serif;max-width:640px;margin:3rem auto;padding:1rem}
 input,button{font-size:1rem;padding:.6rem;width:100%;box-sizing:border-box;margin:.5rem 0}
</style>
<h1>Universal Stream Renamer</h1>
<p>Paste the manifest URL of your <strong>source add‑on</strong> (e.g. Torrentio):</p>
<input id="src" placeholder="${DEFAULT_SOURCE}">
<button onclick="save()">Save &amp; Reload Stremio</button>
<script>
 const EL = document.getElementById('src');
 EL.value = localStorage.getItem('usr_default_source') || '';
 function save(){
   localStorage.setItem('usr_default_source', EL.value.trim());
   alert('Saved! Now remove & re‑add the add‑on in Stremio so it picks up the new URL.');
 }
</script>`);
});

/*─────────  mount Stremio router & start  ─────────*/
app.use("/", getRouter(builder.getInterface()));

http.createServer(app).listen(PORT, () => {
  console.log(`🚀 Add‑on ready at http://127.0.0.1:${PORT}/manifest.json`);
});
