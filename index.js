/**************************************************************************
 * UNIVERSAL STREAM RENAMER – 4.2.4  (fast, timeout‑safe)
 **************************************************************************/

const express = require("express");
const http    = require("http");
const { addonBuilder, getRouter } = require("stremio-addon-sdk");
const AbortController             = global.AbortController || require("abort-controller");

const PORT = process.env.PORT || 10000;
const DEFAULT_SOURCE = "https://torrentio.strem.fun/manifest.json";
const FALLBACK_MP4   = "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4";

const manifest = {
  id:"org.universal.stream.renamer",
  version:"4.2.4",
  name:"Universal Stream Renamer",
  description:"Fast, clean names; Chromecast‑safe proxy.",
  resources:["stream"], types:["movie","series"], idPrefixes:["tt"],
  catalogs:[], behaviorHints:{ configurable:true }
};

const builder = addonBuilder(manifest);

/* 5‑minute RAM cache */
const cache = new Map();
const TTL = 300_000;
const put = (k,v)=>{ cache.set(k,v); setTimeout(()=>cache.delete(k),TTL); };

builder.defineStreamHandler(async ({ type, id, config, headers }) => {
  const uaRaw = headers?.["user-agent"] || "";
  const ua    = uaRaw.toLowerCase();
  let isTV    = /(exoplayer|stagefright|dalvik|android tv|shield|bravia|crkey|smarttv)/i.test(ua);
  if (!ua) isTV = true;                    // no UA → Chromecast/TV

  console.log("\nUA:", uaRaw || "<none>", "→ isTV =", isTV);

  const src = (config?.sourceAddonUrl || DEFAULT_SOURCE).replace("stremio://","https://");
  const u   = new URL(src);
  const cacheKey = `${type}:${id}:${u.search}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey);

  /* fetch Torrentio with device‑specific timeout */
  const timeoutMs = isTV ? 5000 : 3000;
  const ctrl = new AbortController();
  const timer = setTimeout(()=>ctrl.abort(), timeoutMs);

  let raw = [];
  try {
    const res = await fetch(`${u.origin}/stream/${type}/${id}.json${u.search}`, { signal: ctrl.signal });
    clearTimeout(timer);
    if (res.ok) raw = (await res.json()).streams || [];
  } catch (e) {
    console.error("Torrentio fetch", e.type==="aborted"?"timeout":e.message);
  }

  const list = isTV ? raw.slice(0,10) : raw;
  let idx = 1;
  const streams = list.map(s=>{
    const fromRD = s.url?.includes("/resolve/realdebrid/");
    if (isTV) {
      return { ...s, url:`/proxy?u=${encodeURIComponent(s.url)}` };
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

  if (isTV && streams.length===0)
    streams.push({ name:"Fallback MP4",
                   url:`/proxy?u=${encodeURIComponent(FALLBACK_MP4)}`,
                   behaviorHints:{ filename:"Fallback.mp4" } });

  const out = { streams };
  put(cacheKey, out);
  return out;
});

/* EXPRESS APP & /proxy stay the same */
const app = express();

app.get("/configure",(req,res)=>{
  const base=`https://${req.get("host")}/manifest.json`;
  res.type("html").send(`<input id=src style="width:100%;padding:.6rem" placeholder="${DEFAULT_SOURCE}">
<button onclick="copy()">Copy manifest URL</button>
<script>
function copy(){
  const v=document.getElementById('src').value.trim();
  const url=v? '${base}?sourceAddonUrl=' + encodeURIComponent(v) : '${base}';
  navigator.clipboard.writeText(url).then(()=>alert('Copied:\\n'+url));
}
</script>`);});
app.get("/",(_q,r)=>r.redirect("/configure"));

app.get("/proxy",(req,res)=>{
  try{
    const tgt=new URL(req.query.u);
    if(!/(real-debrid|debrid-link|rdt|cache)/i.test(tgt.hostname))
      return res.status(400).send("blocked");
    res.redirect(302,tgt);
  }catch{res.status(400).send("bad url");}
});

app.use("/", getRouter(builder.getInterface()));
http.createServer(app).listen(PORT,()=>console.log("🚀 addon on", PORT));
