/**************************************************************************
 * UNIVERSAL STREAM RENAMER – 4.3.6  (maximum logging)
 **************************************************************************/

const express = require("express");
const http    = require("http");
const { addonBuilder, getRouter } = require("stremio-addon-sdk");
const AbortController             = global.AbortController || require("abort-controller");
const util = require("util");

const PORT           = process.env.PORT || 10000;
const DEFAULT_SOURCE = "https://torrentio.strem.fun/manifest.json";
const FALLBACK_MP4   = "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4";

const manifest = {
  id:"org.universal.stream.renamer",
  version:"4.3.6",
  name:"Universal Stream Renamer (verbose debug)",
  description:"Logs full Torrentio JSON + filtering details.",
  resources:["stream"], types:["movie","series"], idPrefixes:["tt"],
  catalogs:[], behaviorHints:{ configurable:true },
  config:[{ key:"sourceAddonUrl", type:"text", title:"Source Add‑on Manifest URL" }]
};

const builder = addonBuilder(manifest);

/* 5‑minute cache */
const cache=new Map(); const TTL=300_000;
const cacheSet=(k,v)=>{cache.set(k,v);setTimeout(()=>cache.delete(k),TTL);};

builder.defineStreamHandler(async({type,id,config,headers})=>{
  const ua=headers?.["user-agent"]||""; const uaL=ua.toLowerCase();
  let isTV=/(exoplayer|stagefright|dalvik|android tv|shield|bravia|crkey|smarttv)/i.test(uaL);
  if(!ua) isTV=true;
  console.log("\nUA:",ua||"<none>",", isTV:",isTV);

  const src=(config?.sourceAddonUrl||DEFAULT_SOURCE).replace("stremio://","https://");
  const u=new URL(src); const key=`${type}:${id}:${u.search}`;
  if(cache.has(key)) return cache.get(key);

  const api=`${u.origin}/stream/${type}/${id}.json${u.search}`;
  const ctrl=new AbortController();
  const t=setTimeout(()=>ctrl.abort(),isTV?5000:4000);
  const res=await fetch(api,{signal:ctrl.signal}).catch(e=>{console.error("Fetch error:",e.message);return null;});
  clearTimeout(t);

  if(!res?.ok){
    console.error("HTTP",res?.status,res?.statusText,"for",api);
    return {streams:[]};
  }
  const json=await res.json();
  console.log("Fetched",api,
              "| status:",res.status,
              "| bytes:",res.headers.get("content-length")||"unknown",
              "| total streams:",json.streams?.length||0);

  /* ---- print first 25 raw stream objects ---- */
  console.log("----- RAW Streams (up to 25) -----");
  (json.streams||[]).slice(0,25).forEach((s,i)=>{
    console.log(`#${i+1}`, util.inspect(s,{depth:1,colors:false,maxArrayLength:5}));
  });
  if((json.streams||[]).length>25) console.log("…", (json.streams.length-25), "more");
  console.log("----- end RAW -----");

  const raw=json.streams||[];

  const direct  = raw.filter(s=>s.url && /^https?:/.test(s.url));
  const torrents= raw.filter(s=>!(s.url && /^https?:/.test(s.url)));

  console.log("Direct links:",direct.length,"| Torrents:",torrents.length);

  let list=[...direct,...torrents];
  if(isTV) list=list.slice(0,10);

  let idx=1;
  const streams=list.map(s=>{
    const isDirect=s.url && /^https?:/.test(s.url);
    const isRD=s.url?.includes("/resolve/realdebrid/");
    if(isTV && isDirect)
      s={...s,url:`/proxy?u=${encodeURIComponent(s.url.replace(/^http:/,"https:"))}`};
    const label=`${isRD?"[RD] ":""}Stream ${idx++}`;
    return {...s,name:label,title:label,
      behaviorHints:{...(s.behaviorHints||{}),
                     filename:label.replace(/\s+/g,"_")+".mp4"}};
  });

  console.log("First 2 mapped streams:",util.inspect(streams.slice(0,2),{depth:2,colors:false}));

  if(isTV && streams.length===0)
    streams.push({name:"Fallback MP4",
                  url:`/proxy?u=${encodeURIComponent(FALLBACK_MP4)}`,
                  behaviorHints:{filename:"Fallback.mp4"}});

  const out={streams};
  cacheSet(key,out);
  return out;
});

/* Express + /proxy unchanged */
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
app.get("/proxy",(req,res)=>{try{const tgt=new URL(req.query.u);console.log("/proxy 302 →",tgt.hostname);res.redirect(302,tgt);}catch{res.status(400).send("bad");}});
app.use("/",getRouter(builder.getInterface()));
http.createServer(app).listen(PORT,()=>console.log("🚀 add‑on listening on port",PORT));
