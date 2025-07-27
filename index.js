/**************************************************************************
 * UNIVERSAL STREAM RENAMER – 4.3.5  (prints FULL Torrentio JSON)
 *  ▸ Logs the complete JSON object returned by /stream/… (pretty‑printed)
 *  ▸ All other logic unchanged: direct links first, torrents fallback,
 *    TV wraps direct links with /proxy.
 **************************************************************************/

const express = require("express");
const http    = require("http");
const { addonBuilder, getRouter } = require("stremio-addon-sdk");
const AbortController             = global.AbortController || require("abort-controller");
const util = require("util");            // pretty‑printer for full JSON

const PORT = process.env.PORT || 10000;
const DEFAULT_SOURCE = "https://torrentio.strem.fun/manifest.json";
const FALLBACK_MP4   = "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4";

/* manifest */
const manifest = {
  id:"org.universal.stream.renamer",
  version:"4.3.5",
  name:"Universal Stream Renamer (debug‑fullJSON)",
  description:"Prints full Torrentio JSON; direct links first; Chromecast‑safe proxy.",
  resources:["stream"], types:["movie","series"], idPrefixes:["tt"],
  catalogs:[], behaviorHints:{ configurable:true },
  config:[{ key:"sourceAddonUrl", type:"text", title:"Source Add‑on Manifest URL" }]
};

const builder = addonBuilder(manifest);

/* RAM cache 5 min */
const cache = new Map();
const TTL = 300_000;
const cacheSet=(k,v)=>{ cache.set(k,v); setTimeout(()=>cache.delete(k),TTL); };

builder.defineStreamHandler(async ({ type, id, config, headers })=>{
  /* device type */
  const uaRaw=headers?.["user-agent"]||"";
  const ua=uaRaw.toLowerCase();
  let isTV=/(exoplayer|stagefright|dalvik|android tv|shield|bravia|crkey|smarttv)/i.test(ua);
  if(!ua) isTV=true;
  console.log("UA:",uaRaw||"<none>","→ isTV =",isTV);

  /* construct API URL */
  const src=(config?.sourceAddonUrl||DEFAULT_SOURCE).replace("stremio://","https://");
  const u=new URL(src);
  const key=`${type}:${id}:${u.search}`;
  if(cache.has(key)) return cache.get(key);

  const api=`${u.origin}/stream/${type}/${id}.json${u.search}`;
  const ctrl=new AbortController();
  setTimeout(()=>ctrl.abort(),isTV?5000:4000);
  const res=await fetch(api,{signal:ctrl.signal}).catch(()=>null);

  let raw=[];
  if(res?.ok){
    const json=await res.json();

    /* ───── FULL JSON DEBUG (remove after inspecting) ───── */
    console.log("\n=== Torrentio FULL JSON ===");
    console.log(util.inspect(json, { depth:null, colors:false, maxArrayLength:null }));
    console.log("=== end Torrentio JSON ===\n");
    /* ──────────────────────────────────────────────────── */

    raw=json.streams||[];
  }

  /* order: direct first, torrents after */
  const direct=raw.filter(s=>s.url && /^https?:/.test(s.url));
  const torrents=raw.filter(s=>!(s.url && /^https?:/.test(s.url)));
  let list=[...direct,...torrents];
  if(isTV) list=list.slice(0,10);

  /* map & clean */
  let idx=1;
  const streams=list.map(s=>{
    const isDirect=s.url && /^https?:/.test(s.url);
    const isRD=s.url?.includes("/resolve/realdebrid/");
    if(isTV && isDirect)
      s={...s,url:`/proxy?u=${encodeURIComponent(s.url.replace(/^http:/,"https:"))}`};

    const label=`${isRD?"[RD] ":""}Stream ${idx++}`;
    return {...s,
      name:label,title:label,
      behaviorHints:{...(s.behaviorHints||{}),
                     filename:label.replace(/\s+/g,"_")+".mp4"}};
  });

  if(isTV && streams.length===0)
    streams.push({name:"Fallback MP4",
      url:`/proxy?u=${encodeURIComponent(FALLBACK_MP4)}`,
      behaviorHints:{filename:"Fallback.mp4"}});

  const out={streams};
  cacheSet(key,out);
  return out;
});

/* EXPRESS + /proxy unchanged */
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
http.createServer(app).listen(PORT,()=>console.log("🚀 add‑on listening on",PORT));
