/**************************************************************************
 * UNIVERSAL STREAM RENAMER – 4.2.0 fast build
 * • No RD HEAD requests
 * • 2 s fetch timeout
 * • 5 min memory cache
 **************************************************************************/

const express                     = require("express");
const http                        = require("http");
const { addonBuilder, getRouter } = require("stremio-addon-sdk");
let AbortCtrl = global.AbortController;
if (!AbortCtrl) {
  try { AbortCtrl = require("abort-controller"); }
  catch { /* will fall back to no timeout */ }
}

const PORT = process.env.PORT || 10000;
const DEFAULT_SOURCE = "https://torrentio.strem.fun/manifest.json";
const FALLBACK_MP4   = "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4";

/* ─────────── manifest ─────────── */
const manifest = {
  id          : "org.universal.stream.renamer",
  version     : "4.2.0",
  name        : "Universal Stream Renamer",
  description : "Fast, clean stream names; Chromecast‑safe proxy.",
  resources   : ["stream"],
  types       : ["movie", "series"],
  idPrefixes  : ["tt"],
  catalogs    : [],
  config      : [{ key:"sourceAddonUrl", type:"text", title:"Source Add‑on Manifest URL" }],
  behaviorHints: { configurable: true }
};

const builder = addonBuilder(manifest);

/* ─────────── in‑memory cache (5 min TTL) ─────────── */
const cache = new Map();
function putCache(key, data) {
  cache.set(key, data);
  setTimeout(()=>cache.delete(key), 5 * 60_000); // 5 minutes
}

/* ─────────── STREAM HANDLER ─────────── */
builder.defineStreamHandler(async ({ type, id, config, headers }) => {
  const ua   = (headers?.["user-agent"] || "").toLowerCase();
  const isTV = /stremio.*(android|tv)|crkey|smarttv/.test(ua);

  const src = (config?.sourceAddonUrl || DEFAULT_SOURCE).replace("stremio://", "https://");
  const srcURL = new URL(src);
  const apiKey = `${type}:${id}:${srcURL.search}`;          // cache key

  if (cache.has(apiKey)) return cache.get(apiKey);

  const apiURL = `${srcURL.origin}/stream/${type}/${id}.json${srcURL.search}`;
  const controller = new AbortController();
  const t = setTimeout(()=>controller.abort(), 2000);

  let rawStreams = [];
  try {
    const r = await fetch(apiURL, { signal: controller.signal });
    clearTimeout(t);
    if (r.ok) rawStreams = (await r.json()).streams || [];
    else console.error("Torrentio HTTP", r.status, r.statusText);
  } catch (e) {
    console.error("Torrentio fetch error:", e.type === "aborted" ? "timeout" : e.message);
  }

  /* map → clean names */
  let idx = 1;
  const streams = rawStreams.map(s => {
    const isRD = s.url?.includes("/resolve/realdebrid/");
    if (isTV) {
      /* wrap for TV (keeps original title) */
      return { ...s, url: `/proxy?u=${encodeURIComponent(s.url)}` };
    }
    /* desktop/web: clean label */
    const tag   = isRD ? "[RD] " : "";
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

  /* TV fallback if empty */
  if (isTV && streams.length === 0)
    streams.push({ name:"Fallback MP4",
                   url:`/proxy?u=${encodeURIComponent(FALLBACK_MP4)}`,
                   behaviorHints:{ filename:"Fallback.mp4" } });

  const result = { streams };
  putCache(apiKey, result);
  console.log(`🟢 ${type} ${id} → ${streams.length} streams (${isTV?"TV":"desktop"})`);
  return result;
});

/* ─────────── EXPRESS APP ─────────── */
const app = express();

/* /configure helper */
app.get("/configure", (req, res) => {
  const base = `https://${req.get("host")}/manifest.json`;
  res.type("html").send(`
<!doctype html><meta charset=utf-8>
<title>Universal Stream Renamer – Configure</title>
<input id=src style="width:100%;padding:.6rem" placeholder="${DEFAULT_SOURCE}">
<button onclick="copy()">Copy manifest URL</button>
<script>
function copy(){
  const v=document.getElementById('src').value.trim();
  const url=v? '${base}?sourceAddonUrl=' + encodeURIComponent(v) : '${base}';
  navigator.clipboard.writeText(url).then(()=>alert('Copied: '+url));
}
</script>`);
});
app.get("/", (_q,r)=>r.redirect("/configure"));

/* Chromecast‑safe proxy */
app.get("/proxy",(req,res)=>{
  try{
    const tgt=new URL(req.query.u);
    if(!/(real-debrid|debrid-link|rdt|cache)/i.test(tgt.hostname))
      return res.status(400).send("blocked");
    res.redirect(302,tgt);
  }catch{res.status(400).send("bad url");}
});

/* SDK router */
app.use("/", getRouter(builder.getInterface()));

/* start server */
http.createServer(app).listen(PORT, () => console.log("🚀 Add‑on running on port", PORT));
