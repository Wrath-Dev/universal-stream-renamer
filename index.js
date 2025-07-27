/**************************************************************************
 * UNIVERSAL STREAM RENAMER – 4.4.0
 * • Captures ?sourceAddonUrl on /manifest.json and remembers it
 * • Decodes it (so %7C ⇒ | and %3D ⇒ =)
 * • Re‑uses it for every /stream/… request → RD links back
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
  version:"4.4.0",
  name:"Universal Stream Renamer",
  description:"Keeps Real‑Debrid token; Chromecast‑safe proxy; clean names.",
  resources:["stream"], types:["movie","series"], idPrefixes:["tt"],
  catalogs:[],
  config:[{ key:"sourceAddonUrl", type:"text", title:"Source Add‑on Manifest URL" }],
  behaviorHints:{ configurable:true }
};

const builder = addonBuilder(manifest);

/* tiny RAM cache */
const cache = new Map(); const TTL = 300_000;
const put = (k,v)=>{ cache.set(k,v); setTimeout(()=>cache.delete(k),TTL); };

/* ───── stream handler ───── */
builder.defineStreamHandler(async ({ type, id, config, headers }) => {

  /* remember last manifest URL (may be undefined here) */
  if (config?.sourceAddonUrl) global.lastSrc = config.sourceAddonUrl;

  const raw = global.lastSrc || DEFAULT_SOURCE;
  const src = decodeURIComponent(raw).replace("stremio://","https://");

  /* build /stream/… keeping the RD token & all options */
  const base = src.replace(/\/manifest\.json$/,"");
  const qStr = src.includes("?") ? src.slice(src.indexOf("?")) : "";
  const api  = `${base}/stream/${type}/${id}.json${qStr}`;

  /* detect Chromecast / Android‑TV */
  const ua = (headers?.["user-agent"]||"").toLowerCase();
  let isTV = /android|exoplayer|crkey|smarttv|bravia|shield/.test(ua);
  if (!headers?.["user-agent"]) isTV = true;          // Chromecast has empty UA
  console.log("\nUA:", headers?.["user-agent"]||"<none>", "→ isTV =", isTV);

  /* serve from cache if available */
  const key = `${type}:${id}:${qStr}`; if (cache.has(key)) return cache.get(key);

  /* fetch Torrentio */
  const ctrl = new AbortController(); setTimeout(()=>ctrl.abort(), isTV?5000:4000);
  const r = await fetch(api,{signal:ctrl.signal}).catch(e=>console.error("Fetch",e.message));
  if (!r?.ok){ console.error("HTTP", r?.status); return {streams:[]}; }

  const json = await r.json();
  const rawStreams = json.streams||[];
  console.log("Fetched", api, "| total streams:", rawStreams.length);

  /* quick debug: first 5 items */
  rawStreams.slice(0,5).forEach((s,i)=>{
    console.log(`#${i+1}`, s.url ? "url:" : "hash:", (s.url||s.infoHash).slice(0,70));
  });

  const direct   = rawStreams.filter(s=>s.url && /^https?:/.test(s.url));
  const torrents = rawStreams.filter(s=>!(s.url && /^https?:/.test(s.url)));
  console.log("Direct links:", direct.length,"| Torrents:", torrents.length);

  let list = [...direct, ...torrents];
  if (isTV) list=list.slice(0,10);                  // faster list for TV

  /* map + clean */
  let n=1;
  const streams = list.map(s=>{
    const label = `Stream ${n++}`;
    const rdTag = s.url?.includes("/resolve/realdebrid/") ? "[RD] " : "";
    const out = {
      ...s,
      name : rdTag+label,
      title: rdTag+label,
      behaviorHints:{ ...(s.behaviorHints||{}), filename:label.replace(/\s+/g,"_")+".mp4" }
    };
    if (isTV && s.url) out.url = `/proxy?u=${encodeURIComponent(s.url.replace(/^http:/,"https:"))}`;
    return out;
  });

  if (isTV && streams.length===0)
    streams.push({ name:"Fallback MP4", url:`/proxy?u=${encodeURIComponent(FALLBACK_MP4)}`,
                   behaviorHints:{filename:"Fallback.mp4"} });

  const result = { streams }; put(key,result); return result;
});

/* ───── Express helper & proxy ───── */
const app = express();

/* ① Intercept /manifest.json to remember sourceAddonUrl */
app.get("/manifest.json",(req,res,next)=>{
  if (req.query.sourceAddonUrl) global.lastSrc = req.query.sourceAddonUrl;
  next();   // hand over to stremio router
});

/* configure page (copy button) */
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

/* Chromecast‑safe redirect */
app.get("/proxy",(req,res)=>{
  try{ res.redirect(302,new URL(req.query.u)); }
  catch{ res.status(400).send("bad url"); }
});

/* stremio routes */
app.use("/", getRouter(builder.getInterface()));
http.createServer(app).listen(PORT, ()=>console.log("🚀 add‑on listening on",PORT));
