/**************************************************************************
 * UNIVERSAL STREAM RENAMER – 4.3.4
 * • Direct HTTP/RD links first, torrents after (TV capped at 10)
 * • TV wraps direct links in /proxy
 * • DEBUG: prints first 15 raw streams from Torrentio
 **************************************************************************/

const express = require("express");
const http    = require("http");
const { addonBuilder, getRouter } = require("stremio-addon-sdk");
const AbortController             = global.AbortController || require("abort-controller");

const PORT           = process.env.PORT || 10000;
const DEFAULT_SOURCE = "https://torrentio.strem.fun/manifest.json";
const FALLBACK_MP4   = "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4";

/* ─────────── manifest ─────────── */
const manifest = {
  id          : "org.universal.stream.renamer",
  version     : "4.3.4",
  name        : "Universal Stream Renamer",
  description : "Direct links first; torrents fallback; Chromecast‑safe proxy.",
  resources   : ["stream"],
  types       : ["movie", "series"],
  idPrefixes  : ["tt"],
  catalogs    : [],
  behaviorHints: { configurable: true },
  config      : [{ key:"sourceAddonUrl", type:"text", title:"Source Add‑on Manifest URL" }]
};

const builder = addonBuilder(manifest);

/* 5‑minute RAM cache */
const cache = new Map();
const TTL   = 300_000;
const putCache = (k,v)=>{ cache.set(k,v); setTimeout(()=>cache.delete(k), TTL); };

builder.defineStreamHandler(async ({ type, id, config, headers }) => {
  /* device detection */
  const uaRaw = headers?.["user-agent"] || "";
  const ua    = uaRaw.toLowerCase();
  let isTV    = /(exoplayer|stagefright|dalvik|android tv|shield|bravia|crkey|smarttv)/i.test(ua);
  if (!ua) isTV = true;                    // no UA → Chromecast / Android‑TV
  console.log("UA:", uaRaw || "<none>", "→ isTV =", isTV);

  /* source manifest URL */
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

  let raw = [];
  if (res?.ok) {
    const json = await res.json();

    /* ─── DEBUG: show first 15 streams exactly as returned ─── */
    console.log("\n=== Torrentio RAW response ===");
    console.log("total streams:", json.streams?.length ?? 0);
    json.streams?.slice(0, 15).forEach((s, i) => {
      const head = s.url
        ? `url  : ${s.url.slice(0, 70)}${s.url.length > 70 ? "…" : ""}`
        : `hash : ${s.infoHash?.slice(0, 12) || "none"}`;
      console.log(`#${(i+1).toString().padEnd(2)} ${head}`);
    });
    console.log("=== end RAW ===================\n");
    /* ─────────────────────────────────────────────────────── */

    raw = json.streams || [];
  }

  /* direct links first, torrents after */
  const direct   = raw.filter(s => s.url && /^https?:/.test(s.url));
  const torrents = raw.filter(s => !(s.url && /^https?:/.test(s.url)));
  let list       = [...direct, ...torrents];
  if (isTV) list = list.slice(0, 10);          // TV shows at most 10 rows

  /* map & clean */
  let idx = 1;
  const streams = list.map(s => {
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

  /* fallback for TV when no streams */
  if (isTV && streams.length === 0)
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

app.use("/", getRouter(builder.getInterface()));

/* start server */
http.createServer(app).listen(PORT, ()=>console.log("🚀 add‑on listening on", PORT));
