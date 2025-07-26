/**************************************************************************
 * UNIVERSAL STREAM RENAMER  –  addon.js  (rename only RD streams)
 * npm i express && node addon.js
 **************************************************************************/

const express                     = require("express");
const http                        = require("http");
const { addonBuilder, getRouter } = require("stremio-addon-sdk");

const PORT           = process.env.PORT || 7001;
const DEFAULT_SOURCE = "https://torrentio.strem.fun/manifest.json";
const FALLBACK_MP4   = "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4";

const manifest = {
  id          : "org.universal.stream.renamer",
  version     : "3.3.5",
  name        : "Universal Stream Renamer",
  description : "Renames *only* Real‑Debrid streams; Chromecast‑safe proxy.",
  resources   : ["stream"],
  types       : ["movie", "series"],
  idPrefixes  : ["tt"],
  catalogs    : [],
  config      : [{ key: "sourceAddonUrl", type: "text", title: "Source Add‑on Manifest URL" }],
  behaviorHints: { configurable: true }
};

const builder     = new addonBuilder(manifest);
const userConfigs = {};

/* follow one Real‑Debrid redirect */
async function resolveRD(u) {
  try {
    const r = await fetch(u, { method: "HEAD", redirect: "manual", timeout: 4000 });
    return r.headers.get("location") || u;
  } catch { return u; }
}

builder.defineStreamHandler(async ({ type, id, config, headers }) => {
  const ua   = (headers?.["user-agent"] || "").toLowerCase();
  const isTV = ua.includes("android") || ua.includes("crkey") || ua.includes("smarttv");

  let src = config?.sourceAddonUrl || userConfigs.default || DEFAULT_SOURCE;
  if (config?.sourceAddonUrl) userConfigs.default = src;
  if (src.startsWith("stremio://")) src = src.replace("stremio://", "https://");

  const u = new URL(src);
  const api = `${u.origin}/stream/${type}/${id}.json${u.search}`;
  console.log("🔗", api);

  let streams = [];
  try {
    const r = await fetch(api, { timeout: 4000 });
    if (r.ok) {
      const json = await r.json();
      console.log("🌐 Torrentio streams length:", json.streams?.length || 0);
      const raw = json.streams || [];

      streams = await Promise.all(raw.map(async (st, i) => {
        let isRD = false;
        if (st.url?.includes("/resolve/realdebrid/")) {
          const final = await resolveRD(st.url);
          st.url = isTV ? `/proxy?u=${encodeURIComponent(final)}` : final;
          isRD = true;
        }

        /* rename ONLY Real‑Debrid streams for desktop */
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
    streams.push({ name:"Fallback MP4", url:`/proxy?u=${encodeURIComponent(FALLBACK_MP4)}`,
                   behaviorHints:{ filename:"Fallback.mp4" } });

  return { streams };
});

/* /proxy 302 */
function allowed(u){
  try{
    const {hostname,protocol}=new URL(u);
    return /(real-debrid|debrid-link|rdt|cache)/i.test(hostname) &&
           ["http:","https:"].includes(protocol);
  }catch{return false;}
}
const app = express();
app.get("/proxy",(req,res)=>{
  const u=req.query.u;
  if(!allowed(u)) return res.status(400).send("invalid target");
  res.redirect(302,u);
});

/* minimal configure UI */
app.get("/configure",(req,res)=>{
  const host=req.get("host"), proto=req.secure?"https":"http";
  const base=`${proto}://${host}/manifest.json`;
  res.type("html").send(`<input id=src style="width:100%" placeholder="${DEFAULT_SOURCE}">
<button onclick="copy()">Copy manifest URL</button>
<script>
function copy(){
 const v=document.getElementById('src').value.trim();
 const url=v? '${base}?sourceAddonUrl=' + encodeURIComponent(v) : '${base}';
 navigator.clipboard.writeText(url).then(()=>alert('Copied!'));
}
</script>`);
});
app.get("/",(_q,r)=>r.redirect("/configure"));
app.use("/", getRouter(builder.getInterface()));
http.createServer(app).listen(PORT,()=>console.log(`🚀 http://localhost:${PORT}/configure`));
