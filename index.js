/**************************************************************************
 * UNIVERSAL STREAM RENAMER – 4.2.3  (fast, TV‑safe, full file)
 **************************************************************************/

const express                     = require("express");
const http                        = require("http");
const { addonBuilder, getRouter } = require("stremio-addon-sdk");
const AbortController             = global.AbortController || require("abort-controller");

const PORT           = process.env.PORT || 10000;   // Render injects PORT
const DEFAULT_SOURCE = "https://torrentio.strem.fun/manifest.json";
const FALLBACK_MP4   = "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4";

/* ─────────── manifest ─────────── */
const manifest = {
  id          : "org.universal.stream.renamer",
  version     : "4.2.3",
  name        : "Universal Stream Renamer",
  description : "Fast, clean names; Chromecast‑safe proxy.",
  resources   : ["stream"],
  types       : ["movie", "series"],
  idPrefixes  : ["tt"],
  catalogs    : [],
  config      : [{ key:"sourceAddonUrl", type:"text", title:"Source Add‑on Manifest URL" }],
  behaviorHints: { configurable: true }
};

const builder = addonBuilder(manifest);

/* ─────────── 5‑minute RAM cache ─────────── */
const cache = new Map();
const TTL   = 300_000;             // 5 min
function cacheSet(k, v){ cache.set(k, v); setTimeout(()=>cache.delete(k), TTL); }

/* ─────────── STREAM HANDLER ─────────── */
builder.defineStreamHandler(async ({ type, id, config, headers }) => {
  const uaRaw = headers && headers["user-agent"] ? headers["user-agent"] : "";
  const ua    = uaRaw.toLowerCase();

  /* Detect Chromecast / Android‑TV */
  let isTV = /(exoplayer|stagefright|dalvik|android tv|shield|bravia|crkey|smarttv)/i.test(ua);
  if (!ua) isTV = true;  // no UA header → assume TV device

  /* DEBUG: print once per request (remove after testing) */
  console.log("\nUA:", uaRaw || "<none>", "→ isTV =", isTV);

  /* Source manifest */
  const src = (config?.sourceAddonUrl || DEFAULT_SOURCE).replace("stremio://","https://");
  const u   = new URL(src);
  const key = `${type}:${id}:${u.search}`;           // cache key
  if (cache.has(key)) return cache.get(key);

  /* Fetch Torrentio (2 s timeout) */
  const api = `${u.origin}/stream/${type}/${id}.json${u.search}`;
  const ctrl = new AbortController(); setTimeout(()=>ctrl.abort(), 5000);
  const res  = await fetch(api, { signal: ctrl.signal }).catch(()=>null);
  const raw  = res?.ok ? (await res.json()).streams || [] : [];

  /* Limit list size on TV */
  const list = isTV ? raw.slice(0, 10) : raw;

  /* Map & clean names */
  let idx = 1;
  const streams = list.map(s => {
    const fromRD = s.url?.includes("/resolve/realdebrid/");
    if (isTV){
      return { ...s, url: `/proxy?u=${encodeURIComponent(s.url)}` };
    }
    const tag   = fromRD ? "[RD] " : "";
    const label = `${tag}Stream ${idx++}`;
    return {
      ...s,
      name : label,
      title: label,
      behaviorHints:{
        ...(s.behaviorHints||{}),
        filename: label.replace(/\s+/g,"_") + ".mp4"
      }
    };
  });

  if (isTV && streams.length === 0)
    streams.push({ name:"Fallback MP4",
                   url:`/proxy?u=${encodeURIComponent(FALLBACK_MP4)}`,
                   behaviorHints:{ filename:"Fallback.mp4" } });

  const out = { streams };
  cacheSet(key, out);
  return out;
});

/* ─────────── EXPRESS APP ─────────── */
const app = express();

/* /configure helper page */
app.get("/configure",(req,res)=>{
  const base=`https://${req.get("host")}/manifest.json`;
  res.type("html").send(`
<input id=src style="width:100%;padding:.6rem" placeholder="${DEFAULT_SOURCE}">
<button onclick="copy()">Copy manifest URL</button>
<script>
function copy(){
  const v=document.getElementById('src').value.trim();
  const url=v? '${base}?sourceAddonUrl=' + encodeURIComponent(v) : '${base}';
  navigator.clipboard.writeText(url).then(()=>alert('Copied:\\n'+url));
}
</script>`);
});
app.get("/",(_q,r)=>r.redirect("/configure"));

/* Chromecast‑safe proxy */
app.get("/proxy",(req,res)=>{
  try{
    const tgt=new URL(req.query.u);
    if(!/(real-debrid|debrid-link|rdt|cache)/i.test(tgt.hostname))
      return res.status(400).send("blocked");
    console.log("/proxy 302 →", tgt.hostname);   // optional debug
    res.redirect(302,tgt);
  }catch{res.status(400).send("bad url");}
});

/* Stremio SDK router */
app.use("/", getRouter(builder.getInterface()));

/* Start server */
http.createServer(app).listen(PORT, ()=>console.log("🚀 add‑on on", PORT));
