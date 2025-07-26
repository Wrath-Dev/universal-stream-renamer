/**************************************************************************
 * UNIVERSAL STREAM RENAMER – 4.3.0 (clean names everywhere, TV‑safe)
 **************************************************************************/

const express = require("express");
const http    = require("http");
const { addonBuilder, getRouter } = require("stremio-addon-sdk");
const AbortController             = global.AbortController || require("abort-controller");

const PORT           = process.env.PORT || 10000;
const DEFAULT_SOURCE = "https://torrentio.strem.fun/manifest.json";
const FALLBACK_MP4   = "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4";

/* manifest */
const manifest = {
  id:"org.universal.stream.renamer",
  version:"4.3.0",
  name:"Universal Stream Renamer",
  description:"Clean numbered names on all devices; Chromecast‑safe proxy.",
  resources:["stream"], types:["movie","series"], idPrefixes:["tt"],
  catalogs:[], behaviorHints:{ configurable:true }
};
const builder = addonBuilder(manifest);

/* 5‑minute RAM cache */
const cache = new Map();
const TTL   = 300_000;
const setCache = (k,v)=>{ cache.set(k,v); setTimeout(()=>cache.delete(k),TTL); };

builder.defineStreamHandler(async ({ type, id, config, headers }) => {
  /* ── device detection ── */
  const uaRaw = headers?.["user-agent"] || "";
  const ua    = uaRaw.toLowerCase();
  let isTV    = /(exoplayer|stagefright|dalvik|android tv|shield|bravia|crkey|smarttv)/i.test(ua);
  if (!ua) isTV = true;                          // no UA → Chromecast/TV
  console.log("UA:", uaRaw || "<none>", "→ isTV =", isTV);

  /* ── source manifest ── */
  const src = (config?.sourceAddonUrl || DEFAULT_SOURCE).replace("stremio://","https://");
  const u   = new URL(src);
  const cKey= `${type}:${id}:${u.search}`;
  if (cache.has(cKey)) return cache.get(cKey);

  /* ── fetch Torrentio ── */
  const api = `${u.origin}/stream/${type}/${id}.json${u.search}`;
  const timeoutMs = isTV ? 5000 : 4000;
  const ctrl = new AbortController(); const tmr = setTimeout(()=>ctrl.abort(), timeoutMs);
  const res  = await fetch(api, { signal: ctrl.signal }).catch(()=>null);
  clearTimeout(tmr);
  const raw  = res?.ok ? (await res.json()).streams || [] : [];

  /* limit list size on TV */
  const list = isTV ? raw.slice(0, 10) : raw;

  /* ── map & clean ── */
  let idx = 1;
  const streams = list.map(s=>{
    const isDirect = s.url && /^https?:/.test(s.url);
    const isRD     = s.url?.includes("/resolve/realdebrid/");

    /* Wrap only direct links for TV */
    if (isTV && isDirect)
      s = { ...s, url:`/proxy?u=${encodeURIComponent(s.url)}` };

    /* Clean name for EVERY device */
    const tag   = isRD ? "[RD] " : "";
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

  /* fallback for TV if list empty */
  if (isTV && streams.length===0)
    streams.push({ name:"Fallback MP4",
                   url:`/proxy?u=${encodeURIComponent(FALLBACK_MP4)}`,
                   behaviorHints:{ filename:"Fallback.mp4" } });

  const out = { streams };
  setCache(cKey, out);
  return out;
});

/* ─────────── Express app ─────────── */
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

/* Chromecast‑safe proxy */
app.get("/proxy",(req,res)=>{
  try{
    const tgt=new URL(req.query.u);
    console.log("/proxy 302 →", tgt.hostname);
    res.redirect(302,tgt);
  }catch{res.status(400).send("bad url");}
});

/* SDK router */
app.use("/", getRouter(builder.getInterface()));

/* start */
http.createServer(app).listen(PORT, ()=>console.log("🚀 add‑on on", PORT));
