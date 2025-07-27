/**************************************************************************
 * UNIVERSAL STREAM RENAMER – 4.3.1
 * • Direct links first, torrents after → faster Chromecast start
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
  version:"4.3.1",
  name:"Universal Stream Renamer",
  description:"Direct links first; Chromecast‑safe proxy.",
  resources:["stream"], types:["movie","series"], idPrefixes:["tt"],
  catalogs:[], behaviorHints:{ configurable:true }
};
const builder = addonBuilder(manifest);

/* 5‑minute cache */
const cache = new Map();
const setCache=(k,v)=>{ cache.set(k,v); setTimeout(()=>cache.delete(k),300_000); };

builder.defineStreamHandler(async ({ type, id, config, headers })=>{
  const uaRaw=headers?.["user-agent"]||""; const ua=uaRaw.toLowerCase();
  let isTV=/(exoplayer|stagefright|dalvik|android tv|shield|bravia|crkey|smarttv)/i.test(ua);
  if(!ua) isTV=true;
  console.log("UA:",uaRaw||"<none>","→ isTV =",isTV);

  const src=(config?.sourceAddonUrl||DEFAULT_SOURCE).replace("stremio://","https://");
  const u=new URL(src); const key=`${type}:${id}:${u.search}`;
  if(cache.has(key)) return cache.get(key);

  const api=`${u.origin}/stream/${type}/${id}.json${u.search}`;
  const ctrl=new AbortController(); setTimeout(()=>ctrl.abort(),isTV?5000:4000);
  const res=await fetch(api,{signal:ctrl.signal}).catch(()=>null);
  const raw=res?.ok?(await res.json()).streams||[]:[];
  /* sort: direct links first */
  const direct   = raw.filter(s=>s.url && /^https?:/.test(s.url));
  const torrents = raw.filter(s=>!(s.url && /^https?:/.test(s.url)));
  const list     = isTV ? [...direct,...torrents].slice(0,10)
                        : [...direct,...torrents];

  let idx=1;
  const streams=list.map(s=>{
    const isDirect = s.url && /^https?:/.test(s.url);
    const isRD = s.url?.includes("/resolve/realdebrid/");
    if(isTV && isDirect)
      s={...s,url:`/proxy?u=${encodeURIComponent(s.url)}`};

    const tag=isRD?"[RD] ":"";
    const label=`${tag}Stream ${idx++}`;
    return {...s,name:label,title:label,
      behaviorHints:{...(s.behaviorHints||{}),
                     filename:label.replace(/\s+/g,"_")+".mp4"}};
  });
  console.log(streams.slice(0,3))

  if(isTV&&streams.length===0)
    streams.push({name:"Fallback MP4",
      url:`/proxy?u=${encodeURIComponent(FALLBACK_MP4)}`,
      behaviorHints:{filename:"Fallback.mp4"}});

  const out={streams}; setCache(key,out); return out;
});

/* Express & /proxy unchanged */
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
app.get("/proxy",(req,res)=>{try{res.redirect(302,new URL(req.query.u));}catch{res.status(400).send("bad");}});
app.use("/",getRouter(builder.getInterface()));
http.createServer(app).listen(PORT,()=>console.log("🚀 addon on",PORT));
