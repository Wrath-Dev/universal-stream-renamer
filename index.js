/**************************************************************************
 * UNIVERSAL STREAM RENAMER – 4.3.3  (direct links first + raw debug)
 *   • Direct HTTP/RD links shown first; torrents follow (TV capped at 10)
 *   • Clean Stream names on all devices
 *   • TV devices wrap direct URLs with /proxy?u=
 *   • Prints the first 5 raw stream objects so you can inspect “url” vs
 *     “infoHash” — remove the DEBUG block once verified.
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
  version:"4.3.3",
  name:"Universal Stream Renamer",
  description:"Direct links first; torrents fallback; Chromecast‑safe proxy.",
  resources:["stream"], types:["movie","series"], idPrefixes:["tt"],
  catalogs:[], behaviorHints:{ configurable:true },
  config   :[{ key:"sourceAddonUrl", type:"text", title:"Source Add‑on Manifest URL" }]
};

const builder = addonBuilder(manifest);

/* 5‑minute cache */
const cache = new Map();
const TTL   = 300_000;
const putCache = (k,v)=>{ cache.set(k,v); setTimeout(()=>cache.delete(k), TTL); };

builder.defineStreamHandler(async ({ type, id, config, headers }) => {
  /* device detection */
  const uaRaw = headers?.["user-agent"] || "";
  const ua    = uaRaw.toLowerCase();
  let isTV    = /(exoplayer|stagefright|dalvik|android tv|shield|bravia|crkey|smarttv)/i.test(ua);
  if (!ua) isTV = true;                                // no UA → Chromecast / TV
  console.log("UA:", uaRaw || "<none>", "→ isTV =", isTV);

  /* manifest / stream source */
  const src = (config?.sourceAddonUrl || DEFAULT_SOURCE).replace("stremio://","https://");
  const u   = new URL(src);
  const cKey= `${type}:${id}:${u.search}`;
  if (cache.has(cKey)) return cache.get(cKey);

  /* fetch Torrentio */
  const api = `${u.origin}/stream/${type}/${id}.json${u.search}`;
  const timeoutMs = isTV ? 5000 : 4000;
  const ctrl = new AbortController();
  const tmr  = setTimeout(()=>ctrl.abort(), timeoutMs);
  const res  = await fetch(api, { signal: ctrl.signal }).catch(()=>null);
  clearTimeout(tmr);

  const raw = res?.ok ? (await res.json()).streams || [] : [];

  /* ─── DEBUG: peek at first 5 raw items ─── */
  console.log("RAW[0‑4] ===>");
  raw.slice(0,5).forEach((s,i)=>{
    const head = s.url ? ("url:" + s.url.slice(0,60)+(s.url.length>60?"…":""))
                       : ("infoHash:"+(s.infoHash?.slice(0,10) || "none"));
    console.log(`  #${i+1}`, head, s.name || "");
  });
  console.log("<=== end\n");
  /* ─────────────────────────────────────── */

  /* direct links first, torrents after */
  const direct   = raw.filter(s => s.url && /^https?:/.test(s.url));
  const torrents = raw.filter(s => !(s.url && /^https?:/.test(s.url)));
  let list       = [...direct, ...torrents];
  if (isTV) list = list.slice(0, 10);                 // cap at 10 rows on TV

  /* map & clean */
  let idx=1;
  const streams=list.map(s=>{
    const isDirect = s.url && /^https?:/.test(s.url);
    const isRD     = s.url?.includes("/resolve/realdebrid/");
    if (isTV && isDirect)
      s = { ...s, url:`/proxy?u=${encodeURIComponent(s.url.replace(/^http:/,"https:"))}` };

    const label = `${isRD ? "[RD] " : ""}Stream ${idx++}`;
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

  /* fallback if list empty on TV */
  if (isTV && streams.length===0)
    streams.push({ name:"Fallback MP4",
                   url:`/proxy?u=${encodeURIComponent(FALLBACK_MP4)}`,
                   behaviorHints:{ filename:"Fallback.mp4" } });

  const out = { streams };
  putCache(cKey, out);
  return out;
});

/* ─────────── Express app & /proxy ─────────── */
const app = express();

/* configure helper */
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
</script>`);});
app.get("/",(_q,r)=>r.redirect("/configure"));

/* proxy */
app.get("/proxy",(req,res)=>{
  try{
    const tgt=new URL(req.query.u);
    console.log("/proxy 302 →", tgt.hostname);
    res.redirect(302,tgt);
  }catch{res.status(400).send("bad url");}
});

/* SDK router */
app.use("/", getRouter(builder.getInterface()));

/* start server */
http.createServer(app).listen(PORT, ()=>console.log("🚀 add‑on listening on", PORT));
