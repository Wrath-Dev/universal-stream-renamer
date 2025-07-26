/**************************************************************************
 * UNIVERSAL STREAM RENAMER  –  addon.js  (Render / production)
 **************************************************************************/

const express                     = require("express");
const http                        = require("http");
const { addonBuilder, getRouter } = require("stremio-addon-sdk");

const PORT           = process.env.PORT || 10000;   // Render sets PORT env
const DEFAULT_SOURCE = "https://torrentio.strem.fun/manifest.json";
const FALLBACK_MP4   = "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4";

/*────────────────────── manifest ──────────────────────*/
const manifest = {
  id          : "org.universal.stream.renamer",
  version     : "4.0.0",
  name        : "Universal Stream Renamer",
  description : "Renames only Real‑Debrid streams; Chromecast‑safe proxy.",
  resources   : ["stream"],
  types       : ["movie", "series"],
  idPrefixes  : ["tt"],
  catalogs    : [],
  config      : [{ key: "sourceAddonUrl", type: "text", title: "Source Add‑on Manifest URL" }],
  behaviorHints: { configurable: true }
};

const builder     = new addonBuilder(manifest);
const userConfigs = {};

/* helper: follow RD redirect once */
async function resolveRD(u) {
  try {
    const r = await fetch(u, { method: "HEAD", redirect: "manual", timeout: 4000 });
    return r.headers.get("location") || u;
  } catch { return u; }
}

/*────────── stream handler ──────────*/
builder.defineStreamHandler(async ({ type, id, config, headers }) => {
  const ua   = (headers?.["user-agent"] || "").toLowerCase();
  const isTV = ua.includes("android") || ua.includes("crkey") || ua.includes("smarttv");

  let src = config?.sourceAddonUrl || userConfigs.default || DEFAULT_SOURCE;
  if (config?.sourceAddonUrl) userConfigs.default = src;
  if (src.startsWith("stremio://")) src = src.replace("stremio://", "https://");

  const urlObj = new URL(src);
  const api = `${urlObj.origin}/stream/${type}/${id}.json${urlObj.search}`;
  console.log("🔗", api);

  let streams = [];
  try {
    const r = await fetch(api, { timeout: 5000 });
    if (r.ok) {
      const { streams: raw = [] } = await r.json();

      streams = await Promise.all(raw.map(async (st, i) => {
        let isRD = false;
        if (st.url?.includes("/resolve/realdebrid/")) {
          st.url = await resolveRD(st.url);
          isRD   = true;
        }

        /* wrap URL for TV / Chromecast */
        if (isTV) st.url = `/proxy?u=${encodeURIComponent(st.url)}`;

        /* rename only RD streams for desktop */
        if (!isTV && isRD) {
          const tag = st.name.match(/\[RD[^\]]*\]/)?.[0] || "[RD]";
          st = { ...st,
            name : `${tag} Stream ${i + 1}`,
            title: "Generic Stream",
            description:`Stream ${i + 1}`,
            behaviorHints:{ ...(st.behaviorHints||{}), filename:`Stream_${i+1}.mp4` }
          };
        }
        return st;
      }));
    }
  } catch(e){ console.error("Torrentio fetch failed:", e.message); }

  if (isTV && streams.length === 0)
    streams.push({ name:"Fallback MP4",
                   url:`/proxy?u=${encodeURIComponent(FALLBACK_MP4)}`,
                   behaviorHints:{ filename:"Fallback.mp4" } });

  return { streams };
});

/*────────── express app ──────────*/
const app = express();

/* 1️⃣  Configure page – register FIRST */
app.get("/configure", (req, res) => {
  const host = req.get("host");
  const base = `https://${host}/manifest.json`;
  res.type("html").send(`
<!doctype html><meta charset=utf-8>
<title>Universal Stream Renamer – Configure</title>
<input id=src style="width:100%;padding:.6rem" placeholder="${DEFAULT_SOURCE}">
<button onclick="copy()">Copy manifest URL</button>
<script>
function copy(){
  const v=document.getElementById('src').value.trim();
  const url=v? '${base}?sourceAddonUrl=' + encodeURIComponent(v) : '${base}';
  navigator.clipboard.writeText(url).then(()=>alert('Copied!')).catch(()=>alert(url));
}
</script>`);
});

/* convenience redirect */
app.get("/", (_q,r)=>r.redirect("/configure"));

/* 2️⃣  Chromecast‑safe proxy */
app.get("/proxy",(req,res)=>{
  try{
    const tgt = new URL(req.query.u);
    if (!/(real-debrid|debrid-link|rdt|cache)/i.test(tgt.hostname))
      return res.status(400).send("blocked");
    res.redirect(302, tgt);
  }catch{ res.status(400).send("bad url"); }
});

/* 3️⃣  SDK router for /manifest.json & /stream/... */
app.use("/", getRouter(builder.getInterface()));

/*──────── start server ────────*/
http.createServer(app).listen(PORT, () => {
  console.log("🚀 Render addon running on port", PORT);
});
