/**************************************************************************
 * UNIVERSAL STREAM RENAMER – 4.4.0  (direct links only)
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
  version:"4.4.0",
  name:"Universal Stream Renamer",
  description:"Only direct links; Chromecast‑safe proxy.",
  resources:["stream"], types:["movie","series"], idPrefixes:["tt"],
  catalogs:[], behaviorHints:{ configurable:true }
};
const builder = addonBuilder(manifest);

/* 5‑minute cache */
const cache = new Map();
const TTL   = 300_000;
const put = (k,v)=>{ cache.set(k,v); setTimeout(()=>cache.delete(k), TTL); };

builder.defineStreamHandler(async ({ type, id, config, headers })=>{
  const uaRaw=headers?.["user-agent"]||""; const ua=uaRaw.toLowerCase();
  let isTV=/(exoplayer|stagefright|dalvik|android tv|shield|bravia|crkey|smarttv)/i.test(ua);
  if(!ua) isTV=true;                // no UA → Chromecast/TV
  console.log("UA:",uaRaw||"<none>","→ isTV =",isTV);

  const src=(config?.sourceAddonUrl||DEFAULT_SOURCE).replace("stremio://","https://");
  const u=new URL(src); const key=`${type}:${id}:${u.search}`;
  if(cache.has(key)) return cache.get(key);

  /* fetch Torrentio (5 s TV, 4 s desktop) */
  const timeoutMs=isTV?5000:4000;
  const ctrl=new AbortController(); const t=setTimeout(()=>ctrl.abort(),timeoutMs);
  const res=await fetch(`${u.origin}/stream/${type}/${id}.json${u.search}`,{signal:ctrl.signal}).catch(()=>null);
  clearTimeout(t);
  const raw=res?.ok?(await res.json()).streams||[]:[];
  
  /* keep only direct links */
  const direct=raw.filter(s=>s.url && /^https?:/.test(s.url));

  const list=isTV?direct.slice(0,10):direct;   // cap at 10 for TV

  let idx=1;
  const streams=list.map(s=>{
    const isRD = s.url?.includes("/resolve/realdebrid/");
    if(isTV)
      s={...s,url:`/proxy?u=${encodeURIComponent(s.url.replace(/^http:/,"https:"))}`};

    const tag=isRD?"[RD] ":"";
    const label=`${tag}Stream ${idx++}`;
    return {...s,name:label,title:label,
      behaviorHints:{...(s.behaviorHints||{}),
                     filename:label.replace(/\s+/g,"_")+".mp4"}};
  });

  /* TV fallback if NO direct links */
  if(isTV && streams.length===0)
    streams.push({ name:"Fallback MP4",
      url:`/proxy?u=${encodeURIComponent(FALLBACK_MP4)}`,
      behaviorHints:{ filename:"Fallback.mp4" } });

  const out={streams}; put(key,out); return out;
});

/* EXPRESS APP & /proxy unchanged */
const app=express();
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
app.get("/proxy",(req,res)=>{try{res.redirect(302,new URL(req.query.u));}catch{res.status(400).send("bad url");}});
app.use("/",getRouter(builder.getInterface()));
http.createServer(app).listen(PORT,()=>console.log("🚀 addon on",PORT));
