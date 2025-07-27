/**************************************************************************
 * UNIVERSAL STREAM RENAMER – 4.3.7
 * • Keeps RD token ⇒ Torrentio again returns "url:" rows
 * • Verbose logging (RAW streams, filter counts, first 2 mapped rows)
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
  version:"4.3.7",
  name:"Universal Stream Renamer (RD token preserved)",
  description:"Direct links first; torrents fallback; Chromecast‑safe proxy.",
  resources:["stream"], types:["movie","series"], idPrefixes:["tt"],
  catalogs:[], behaviorHints:{ configurable:true },
  config:[{ key:"sourceAddonUrl", type:"text", title:"Source Add‑on Manifest URL" }]
};

const builder = addonBuilder(manifest);

/* 5‑minute cache */
const cache = new Map(); const TTL = 300_000;
const cacheSet = (k,v)=>{ cache.set(k,v); setTimeout(()=>cache.delete(k),TTL); };

builder.defineStreamHandler(async ({ type, id, config, headers })=>{
  const uaRaw = headers?.["user-agent"] || "";
  const ua    = uaRaw.toLowerCase();
  let isTV    = /(exoplayer|stagefright|dalvik|android tv|shield|bravia|crkey|smarttv)/i.test(ua);
  if (!ua) isTV = true;
  console.log("\nUA:", uaRaw || "<none>", ", isTV:", isTV);

  /* ----- build API URL while keeping RD token ----- */
  const src  = (config?.sourceAddonUrl || DEFAULT_SOURCE).replace("stremio://","https://");
  const base = src.replace(/\/manifest\.json$/, "");                 // strip filename only
  const q    = src.includes("?") ? src.slice(src.indexOf("?")) : ""; // keep entire query string
  const api  = `${base}/stream/${type}/${id}.json${q}`;              // RD token preserved
  /* ----------------------------------------------- */

  const cacheKey = `${type}:${id}:${q}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey);

  const ctrl = new AbortController();
  setTimeout(()=>ctrl.abort(), isTV ? 5000 : 4000);
  const res  = await fetch(api, { signal: ctrl.signal }).catch(e=>{console.error("Fetch error:",e.message);return null;});
  if (!res?.ok){
    console.error("HTTP",res?.status,res?.statusText,"for",api);
    return { streams: [] };
  }

  const json = await res.json();
  console.log("Fetched", api, "| streams:", json.streams?.length ?? 0);

  /* ----- DEBUG: list first 25 raw streams ----- */
  (json.streams||[]).slice(0,25).forEach((s,i)=>{
    const head = s.url ? `url:${s.url.slice(0,60)}…` : `hash:${s.infoHash?.slice(0,12)}`;
    console.log(`#${i+1}`.padEnd(4), head);
  });
  console.log("----- end RAW -----");
  /* -------------------------------------------- */

  const direct   = (json.streams||[]).filter(s=>s.url && /^https?:/.test(s.url));
  const torrents = (json.streams||[]).filter(s=>!(s.url && /^https?:/.test(s.url)));

  console.log("Direct links:", direct.length, "| Torrents:", torrents.length);

  let list = [...direct, ...torrents];
  if (isTV) list = list.slice(0, 10);

  let idx = 1;
  const streams = list.map(s=>{
    const isDirect = s.url && /^https?:/.test(s.url);
    const isRD     = s.url?.includes("/resolve/realdebrid/");
    if (isTV && isDirect)
      s = { ...s, url:`/proxy?u=${encodeURIComponent(s.url.replace(/^http:/,"https:"))}` };

    const label = `${isRD ? "[RD] " : ""}Stream ${idx++}`;
    return {
      ...s,
      name : label,
      title: label,
      behaviorHints:{ ...(s.behaviorHints||{}), filename: label.replace(/\s+/g,"_")+".mp4" }
    };
  });

  console.log("First 2 mapped:", util.inspect(streams.slice(0,2), { depth:2, colors:false }));

  if (isTV && streams.length === 0)
    streams.push({ name:"Fallback MP4",
                   url:`/proxy?u=${encodeURIComponent(FALLBACK_MP4)}`,
                   behaviorHints:{ filename:"Fallback.mp4" } });

  const out = { streams };
  cacheSet(cacheKey, out);
  return out;
});

/* Express + /proxy (unchanged) */
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
    console.log("/proxy 302 →", tgt.hostname);
    res.redirect(302,tgt);
  }catch{res.status(400).send("bad url");}
});

app.use("/", getRouter(builder.getInterface()));
http.createServer(app).listen(PORT, ()=>console.log("🚀 add‑on listening on", PORT));
