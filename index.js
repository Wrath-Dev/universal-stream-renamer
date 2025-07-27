/**************************************************************************
 * UNIVERSAL STREAM RENAMER — clean Real‑Debrid HTTP streams
 *   • /  →  /configure         (added back)
 *   • /configure, /manifest.json, /stream/… handled by the SDK router
 *   • Chromecast‑safe /proxy redirect
 **************************************************************************/

const express                     = require("express");
const { addonBuilder, getRouter } = require("stremio-addon-sdk");
const http                        = require("http");

const PORT           = process.env.PORT || 10000;
const DEFAULT_SOURCE = "https://torrentio.strem.fun/manifest.json";
const FALLBACK_MP4   = "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4";

/*──────── manifest ────────*/
const manifest = {
  id: "org.universal.stream.renamer",
  version: "3.2.2",
  name: "Universal Stream Renamer",
  description: "Renames Torrentio streams; Chromecast‑safe same‑origin proxy.",
  resources: ["stream"],
  types: ["movie","series"],
  idPrefixes: ["tt"],
  catalogs: [],
  config: [
    { key:"sourceAddonUrl", type:"text",
      title:"Source Add‑on Manifest URL", required:false }
  ],
  behaviorHints:{ configurable:true }
};

const builder = new addonBuilder(manifest);
const userConfigs = Object.create(null);

/* one RD redirect (desktop) */
async function resolveRD(u){
  try{
    const r = await fetch(u,{method:"HEAD",redirect:"manual",timeout:5000});
    return r.headers.get("location") || u;
  }catch{ return u; }
}

/*──────── stream handler ────────*/
builder.defineStreamHandler(async ({type,id,config,headers})=>{
  const ua   = (headers?.["user-agent"]||"").toLowerCase();
  const isTV = ua.includes("android")||ua.includes("crkey")||ua.includes("smarttv");

  let src = config?.sourceAddonUrl || userConfigs.default || DEFAULT_SOURCE;
  if(config?.sourceAddonUrl) userConfigs.default = src;
  if(src.startsWith("stremio://")) src = src.replace("stremio://","https://");

  const api = `${src.replace(/\/manifest\.json$/,"")}/stream/${type}/${id}.json`;

  let raw=[];
  try{
    const r=await fetch(api,{timeout:8000});
    if(r.ok) ({streams:raw=[]}=await r.json());
  }catch(e){ console.error("⚠️ Torrentio fetch failed:",e.message); }

  /* build absolute origin for proxy links */
  const host = headers?.host || process.env.RENDER_EXTERNAL_HOSTNAME || `127.0.0.1:${PORT}`;
  const origin = `https://${host}`;

  const streams = await Promise.all(raw.map(async(s,i)=>{
    if(!s.url) return null;                     // skip magnet‑only rows
    const final = !isTV ? await resolveRD(s.url) : s.url;
    return {
      url : isTV ? `${origin}/proxy?u=${encodeURIComponent(final)}` : final,
      name: `[RD] Stream ${i+1}`,
      title:`[RD] Stream ${i+1}`
    };
  })).then(a=>a.filter(Boolean));

  if(isTV && streams.length===0){               // fallback MP4
    streams.push({
      url : `${origin}/proxy?u=${encodeURIComponent(FALLBACK_MP4)}`,
      name:"Fallback MP4",
      title:"Fallback MP4"
    });
  }

  if(streams[0]) console.log("🟢 First handed to Stremio:",streams[0]);
  return {streams};
});

/*──────── Express wiring ────────*/
const app = express();

/* SDK router: /configure, /manifest.json, /stream/… */
app.use("/", getRouter(builder.getInterface()));

/* root → /configure (THIS is the missing line) */
app.get("/", (_req,res)=> res.redirect("/configure"));

/* Chromecast / Android‑TV same‑origin redirect */
app.get("/proxy",(req,res)=>{
  const u=req.query.u;
  if(!u) return res.status(400).send("missing u");
  res.redirect(302,u);
});

/*──────── launch ────────*/
http.createServer(app).listen(PORT,()=>
  console.log(`🚀 add‑on running on port ${PORT} — manifest at /manifest.json`)
);
