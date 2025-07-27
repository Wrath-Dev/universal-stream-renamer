/**************************************************************************
 * UNIVERSAL STREAM RENAMER – 4.4.1
 *  • Captures ?sourceAddonUrl on /manifest.json
 *  • Keeps Real‑Debrid token for every /stream/… call
 *  • Chromecast‑safe same‑origin /proxy
 *  • Cleans names & strips torrent fields when url is present   ← NEW
 **************************************************************************/

const express = require("express");
const http    = require("http");
const { addonBuilder, getRouter } = require("stremio-addon-sdk");
const AbortController             = global.AbortController || require("abort-controller");

const PORT           = process.env.PORT || 10000;
const DEFAULT_SOURCE = "https://torrentio.strem.fun/manifest.json";
const FALLBACK_MP4   = "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4";

/* ───── manifest ───── */
const manifest = {
  id:"org.universal.stream.renamer",
  version:"4.4.1",
  name:"Universal Stream Renamer",
  description:"Keeps Real‑Debrid token; Chromecast‑safe proxy; clean names.",
  resources:["stream"],
  types:["movie","series"],
  idPrefixes:["tt"],
  catalogs:[],
  config:[{ key:"sourceAddonUrl", type:"text", title:"Source Add‑on Manifest URL" }],
  behaviorHints:{ configurable:true }
};

const builder = addonBuilder(manifest);

/* tiny RAM cache to avoid hammering Torrentio */
const cache = new Map(); const TTL = 300_000;
const put = (k,v)=>{ cache.set(k,v); setTimeout(()=>cache.delete(k),TTL); };

/* ───── stream handler ───── */
builder.defineStreamHandler(async ({ type, id, config, headers }) => {

  /* remember last manifest URL (with RD token) */
  if (config?.sourceAddonUrl) global.lastSrc = config.sourceAddonUrl;

  const raw = global.lastSrc || DEFAULT_SOURCE;
  const src = decodeURIComponent(raw).replace("stremio://","https://");

  /* build /stream/… endpoint while keeping query string (RD token etc.) */
  const base = src.replace(/\/manifest\.json$/,"");
  const qStr = src.includes("?") ? src.slice(src.indexOf("?")) : "";
  const api  = `${base}/stream/${type}/${id}.json${qStr}`;

  /* Chromecast / Android‑TV detection */
  const ua = (headers?.["user-agent"]||"").toLowerCase();
  let isTV = /android|exoplayer|crkey|smarttv|bravia|shield/.test(ua);
  if (!headers?.["user-agent"]) isTV = true;             // Chromecast has empty UA
  console.log("\nUA:", headers?.["user-agent"]||"<none>", "isTV:", isTV);

  /* serve from cache if possible */
  const key = `${type}:${id}:${qStr}`; if (cache.has(key)) return cache.get(key);

  /* fetch Torrentio */
  const ctrl = new AbortController(); setTimeout(()=>ctrl.abort(), isTV?5000:4000);
  const r = await fetch(api,{signal:ctrl.signal}).catch(e=>console.error("Fetch",e.message));
  if (!r?.ok){ console.error("HTTP", r?.status); return {streams:[]}; }

  const rawStreams = (await r.json()).streams || [];
  console.log("Fetched", api, "| total streams:", rawStreams.length);

  rawStreams.slice(0,5).forEach((s,i)=>{
    console.log(`#${i+1}`, s.url ? "url:" : "hash:", (s.url||s.infoHash).slice(0,70));
  });

  const direct   = rawStreams.filter(s=>s.url && /^https?:/.test(s.url));
  const torrents = rawStreams.filter(s=>!(s.url && /^https?:/.test(s.url)));
  console.log("Direct links:", direct.length,"| Torrents:", torrents.length);

  let list = [...direct, ...torrents];
  if (isTV) list = list.slice(0,10);        // shorter list → faster on TV

  /* map + sanitise */
  let n = 1;
  const streams = list.map(s=>{
    const label = `Stream ${n++}`;
    const rdTag = s.url?.includes("/resolve/realdebrid/") ? "[RD] " : "";
    const out = {
      ...s,
      name : rdTag + label,
      title: rdTag + label,
      behaviorHints:{ ...(s.behaviorHints||{}),
                      filename: label.replace(/\s+/g,"_") + ".mp4" }
    };

    /* ⚠️  when we have a direct link, drop torrent‑specific fields */
    if (out.url){
      delete out.infoHash;
      delete out.fileIdx;
      delete out.sources;
    }

    /* Chromecast/Android TV needs same‑origin → /proxy */
    if (isTV && out.url)
      out.url = `/proxy?u=${encodeURIComponent(out.url.replace(/^http:/,"https:"))}`;

    return out;
  });

  /* fallback */
  if (isTV && streams.length===0)
    streams.push({ name:"Fallback MP4",
                   url:`/proxy?u=${encodeURIComponent(FALLBACK_MP4)}`,
                   behaviorHints:{filename:"Fallback.mp4"} });

  const res = { streams }; put(key,res); return res;
});

/* ───── Express helper & proxy ───── */
const app = express();

/* ① capture ?sourceAddonUrl on /manifest.json */
app.get("/manifest.json",(req,res,next)=>{
  if (req.query.sourceAddonUrl) global.lastSrc = req.query.sourceAddonUrl;
  next();
});

/* small configure page */
app.get("/configure",(req,res)=>{
  const base=`https://${req.get("host")}/manifest.json`;
  res.type("html").send(`
<input id=src style="width:100%;padding:.6rem" placeholder="${DEFAULT_SOURCE}">
<button onclick="copy()">Copy manifest URL</button>
<script>
function copy(){
  const v=document.getElementById('src').value.trim();
  const url=v ? '${base}?sourceAddonUrl='+v : '${base}';
  navigator.clipboard.writeText(url).then(()=>alert('Copied:\\n'+url));
}
</script>`);});
app.get("/",(_q,r)=>r.redirect("/configure"));

/* Chromecast‑safe same‑origin redirect */
app.get("/proxy",(req,res)=>{
  try{ res.redirect(302,new URL(req.query.u)); }
  catch{ res.status(400).send("bad url"); }
});

/* mount Stremio routes */
app.use("/", getRouter(builder.getInterface()));
http.createServer(app).listen(PORT, ()=>console.log("🚀 add‑on listening on port",PORT));
