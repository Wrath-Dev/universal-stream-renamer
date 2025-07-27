/**************************************************************************
 * UNIVERSAL STREAM RENAMER – 4.3.7  (RD token preserved)
 * • Builds /stream/… URL by stripping only “/manifest.json”, leaving
 *   *everything after* “?” intact ⇒ RD token reaches Torrentio.
 * • Direct links first, torrents fallback (TV list capped at 10 rows)
 * • Verbose logging so you can verify `url:` rows re‑appear
 **************************************************************************/

const express = require("express");
const http    = require("http");
const { addonBuilder, getRouter } = require("stremio-addon-sdk");
const AbortController             = global.AbortController || require("abort-controller");
const util = require("util");

const PORT           = process.env.PORT || 10000;
const DEFAULT_SOURCE = "https://torrentio.strem.fun/manifest.json";
const FALLBACK_MP4   = "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4";

/* ───────── manifest ───────── */
const manifest = {
  id:"org.universal.stream.renamer",
  version:"4.3.7",
  name:"Universal Stream Renamer",
  description:"Direct links first (RD token preserved); Chromecast‑safe proxy.",
  resources:["stream"],
  types:["movie","series"],
  idPrefixes:["tt"],
  catalogs:[],
  behaviorHints:{ configurable:true },
  config:[{ key:"sourceAddonUrl", type:"text", title:"Source Add‑on Manifest URL" }]
};

const builder = addonBuilder(manifest);

/* simple 5‑minute RAM cache */
const cache = new Map(); const TTL = 300_000;
const put = (k,v)=>{ cache.set(k,v); setTimeout(()=>cache.delete(k),TTL); };

/* ───────── stream handler ───────── */
builder.defineStreamHandler(async ({ type, id, config, headers }) => {
  const uaRaw = headers?.["user-agent"] || "";
  const uaL   = uaRaw.toLowerCase();
  let isTV    = /(exoplayer|stagefright|dalvik|android tv|shield|bravia|crkey|smarttv)/i.test(uaL);
  if (!uaRaw) isTV = true;                                   // Chromecast sends no UA
  console.log("\nUA:", uaRaw || "<none>", "isTV:", isTV);

  /* ----- keep entire query string so RD token survives ----- */
  const src  = (config?.sourceAddonUrl || DEFAULT_SOURCE).replace("stremio://","https://");
  const base = src.replace(/\/manifest\.json$/, "");          // drop only the filename
  const qStr = src.includes("?") ? src.slice(src.indexOf("?")) : "";
  const api  = `${base}/stream/${type}/${id}.json${qStr}`;
  /* --------------------------------------------------------- */

  const cKey = `${type}:${id}:${qStr}`;
  if (cache.has(cKey)) return cache.get(cKey);

  /* fetch Torrentio */
  const ctrl = new AbortController();
  setTimeout(()=>ctrl.abort(), isTV ? 5000 : 4000);
  const res = await fetch(api, { signal: ctrl.signal }).catch(e=>{console.error("Fetch:",e.message);});
  if (!res?.ok) { console.error("HTTP", res?.status, res?.statusText); return { streams: [] }; }

  const json = await res.json();
  console.log("Fetched", api, "| streams:", json.streams?.length ?? 0);

  /* DEBUG: list first 10 rows */
  (json.streams||[]).slice(0,10).forEach((s,i)=>{
    const tag = s.url ? "url" : "hash";
    console.log(`#${i+1}`.padEnd(3), tag + ":", (s.url||s.infoHash).slice(0,60));
  });

  const direct   = (json.streams||[]).filter(s => s.url && /^https?:/.test(s.url));
  const torrents = (json.streams||[]).filter(s => !(s.url && /^https?:/.test(s.url)));

  console.log("Direct links:", direct.length, "| Torrents:", torrents.length);

  let list = [...direct, ...torrents];
  if (isTV) list = list.slice(0, 10);                         // limit rows on TV for speed

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
      behaviorHints:{ ...(s.behaviorHints||{}),
                      filename: label.replace(/\s+/g,"_") + ".mp4" }
    };
  });

  if (isTV && streams.length === 0)
    streams.push({ name:"Fallback MP4",
                   url:`/proxy?u=${encodeURIComponent(FALLBACK_MP4)}`,
                   behaviorHints:{ filename:"Fallback.mp4" } });

  const out = { streams };
  put(cKey, out);
  return out;
});

/* ───────── Express helper & proxy ───────── */
const app = express();

/* simple configure page */
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

/* Chromecast‑safe redirect */
app.get("/proxy",(req,res)=>{
  try{
    const tgt=new URL(req.query.u);
    console.log("/proxy 302 →", tgt.hostname);
    res.redirect(302, tgt);
  }catch{ res.status(400).send("bad url"); }
});

app.use("/", getRouter(builder.getInterface()));
http.createServer(app).listen(PORT, ()=>console.log("🚀 add‑on listening on", PORT));
