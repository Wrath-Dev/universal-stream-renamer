/**************************************************************************
 * UNIVERSAL STREAM RENAMER – v3.2.4
 *   • /configure works again (router mounted first)
 *   • Root “/” now redirects to /configure after the router
 *   • Same stream logic you just tested
 **************************************************************************/

const { addonBuilder, getRouter, serveHTTP } = require("stremio-addon-sdk");
const express  = require("express");
const http     = require("http");

const PORT           = process.env.PORT || 10000;
const DEFAULT_SOURCE = "https://torrentio.strem.fun/manifest.json";
const FALLBACK_MP4   = "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4";

/*──────────────── manifest ────────────────*/
const manifest = {
  id      : "org.universal.stream.renamer",
  version : "3.2.4",
  name    : "Universal Stream Renamer",
  description : "Renames Torrentio streams; Chromecast‑safe proxy.",
  resources : ["stream"],
  types     : ["movie","series"],
  idPrefixes: ["tt"],
  catalogs  : [],
  config    : [{ key:"sourceAddonUrl", type:"text",
                 title:"Source Add‑on Manifest URL", required:false }],
  behaviorHints:{ configurable:true }
};
const builder     = new addonBuilder(manifest);
const userConfigs = Object.create(null);

/* follow one RD redirect for desktop */
async function resolveRD(u){
  try{
    const r = await fetch(u,{method:"HEAD",redirect:"manual",timeout:5000});
    return r.headers.get("location") || u;
  }catch{return u;}
}

/*───────── stream handler ─────────*/
builder.defineStreamHandler(async ({type,id,config,headers})=>{
  const ua   = (headers?.["user-agent"]||"").toLowerCase();
  const isTV = ua.includes("android")||ua.includes("crkey")||ua.includes("smarttv");

  let src = config?.sourceAddonUrl || userConfigs.default || DEFAULT_SOURCE;
  if (config?.sourceAddonUrl) userConfigs.default = src;
  if (src.startsWith("stremio://")) src = src.replace("stremio://","https://");

  const api = `${src.replace(/\/manifest\.json$/,"")}/stream/${type}/${id}.json`;

  let raw=[]; try{
    const r = await fetch(api,{timeout:8000});
    if (r.ok) ({streams:raw=[]}=await r.json());
  }catch(e){ console.error("torrentio fetch fail:",e.message); }

  const host   = headers?.host || process.env.RENDER_EXTERNAL_HOSTNAME || `127.0.0.1:${PORT}`;
  const origin = `https://${host}`;           // Render & Stremio expect HTTPS

  const streams = await Promise.all(raw.map(async (s,i)=>{
    if(!s.url) return null;                   // skip magnet‑only rows
    const final = isTV ? s.url : await resolveRD(s.url);
    return {
      url : isTV ? `${origin}/proxy?u=${encodeURIComponent(final)}` : final,
      name: `[RD] Stream ${i+1}`,
      title:`[RD] Stream ${i+1}`,
      behaviorHints:{ filename:`Stream_${i+1}.mp4` }
    };
  })).then(a=>a.filter(Boolean));

  if(isTV && streams.length===0){
    streams.push({
      url : `${origin}/proxy?u=${encodeURIComponent(FALLBACK_MP4)}`,
      name:"Fallback MP4",title:"Fallback MP4"
    });
  }
  return {streams};
});

/*───────── Express wiring ─────────*/
const app = express();

/* 1️⃣  Mount SDK router FIRST → /configure now exists */
app.use("/", getRouter(builder.getInterface()));

/* 2️⃣  Our Chromecast / Android‑TV same‑origin hop */
app.get("/proxy",(req,res)=>{
  const u=req.query.u;
  if(!u)return res.status(400).send("missing u");
  res.redirect(302,u);
});

/* 3️⃣  Convenience: / → /configure (keep this AFTER router) */
app.get("/",(_req,res)=>res.redirect("/configure"));

http.createServer(app).listen(PORT,
  ()=>console.log(`🚀 add‑on ready on port ${PORT} — /manifest.json /configure`)
);
