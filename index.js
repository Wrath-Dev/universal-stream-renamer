/**************************************************************************
 * UNIVERSAL STREAM RENAMER – 4.2.2 (fast, TV‑safe)
 **************************************************************************/

const express                     = require("express");
const http                        = require("http");
const { addonBuilder, getRouter } = require("stremio-addon-sdk");
const AbortController             = global.AbortController || require("abort-controller");

const PORT           = process.env.PORT || 10000;
const DEFAULT_SOURCE = "https://torrentio.strem.fun/manifest.json";
const FALLBACK_MP4   = "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4";

const manifest = {
  id          : "org.universal.stream.renamer",
  version     : "4.2.2",
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

/* 5‑min RAM cache */
const cache = new Map();
const ttl   = 300_000;
function cacheSet(k, v){ cache.set(k, v); setTimeout(()=>cache.delete(k), ttl); }

builder.defineStreamHandler(async ({ type, id, config, headers }) => {
  const ua   = (headers && headers["user-agent"] ? headers["user-agent"] : "").toLowerCase();
  const isTV = /(exoplayer|stagefright|dalvik|android tv|shield|bravia|crkey|smarttv)/i.test(ua);
  console.log("\nUA:", ua);
  console.log("→ isTV =", isTV);

  /* source manifest URL */
  const src = (config?.sourceAddonUrl || DEFAULT_SOURCE).replace("stremio://","https://");
  const u   = new URL(src);
  const key = `${type}:${id}:${u.search}`;        // cache key
  if (cache.has(key)) return cache.get(key);

  /* fetch Torrentio */
  const api = `${u.origin}/stream/${type}/${id}.json${u.search}`;
  const ctrl = new AbortController(); setTimeout(()=>ctrl.abort(), 2000);
  const res  = await fetch(api, { signal: ctrl.signal }).catch(()=>null);
  const raw  = res?.ok ? (await res.json()).streams || [] : [];

  /* limit count on TV */
  const srcList = isTV ? raw.slice(0, 25) : raw;

  let idx = 1;
  const streams = srcList.map(s => {
    const fromRD = s.url?.includes("/resolve/realdebrid/");
    if (isTV){
      const wrapped = `/proxy?u=${encodeURIComponent(s.url)}`;
      if (idx === 1) console.log("Wrapped URL example:", wrapped.slice(0, 120));
        s.url = wrapped;
      return { ...s, url: `/proxy?u=${encodeURIComponent(s.url)}` };
    }
    const tag   = fromRD ? "[RD] " : "";
    const label = `${tag}Stream ${idx++}`;
    return {
      ...s,
      name : label,
      title: label,
      behaviorHints:{
        ...(s.behaviorHints || {}),
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

/* EXPRESS APP */
const app = express();

app.get("/configure",(req,res)=>{
  const base=`https://${req.get("host")}/manifest.json`;
  res.type("html").send(`
<input id=src style="width:100%;padding:.6rem" placeholder="${DEFAULT_SOURCE}">
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

app.get("/proxy",(req,res)=>{
  try{
    const tgt=new URL(req.query.u);
    console.log("/proxy hit →", tgt.hostname, "…");
    if(!/(real-debrid|debrid-link|rdt|cache)/i.test(tgt.hostname))
      return res.status(400).send("blocked");
    res.redirect(302,tgt);
  }catch{res.status(400).send("bad url");}
});

app.use("/", getRouter(builder.getInterface()));
http.createServer(app).listen(PORT,()=>console.log("🚀 addon on", PORT));
