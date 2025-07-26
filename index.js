/* ─────────── imports (Common‑JS) ─────────── */
const express = require("express");
const http    = require("http");
const { addonBuilder, getRouter } = require("stremio-addon-sdk");
const fetchFn = global.fetch || ((...a)=>import("node-fetch").then(({default:d})=>d(...a)));

/* ─────────── constants ─────────── */
const PORT = process.env.PORT || 7000;
const DEFAULT_SOURCE = "https://torrentio.strem.fun/manifest.json";
const FALLBACK_MP4   = "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4";

/* ─────────── manifest ─────────── */
const manifest = {
  id: "org.universal.stream.renamer",
  version: "3.1.1",
  name: "Universal Stream Renamer",
  description: "Renames Torrentio streams; TV‑safe same‑origin proxy for Real‑Debrid.",
  resources: ["stream"],
  types: ["movie", "series"],
  idPrefixes: ["tt"],
  catalogs: [],
  config: [
    { key: "sourceAddonUrl", type: "text", title: "Source Add‑on Manifest URL", required: false }
  ],
  behaviorHints: { configurable: true }     // Stremio will show “Configure (web)”
};

const builder     = new addonBuilder(manifest);
const userConfigs = {};

/* ─────────── helper: resolve one redirect ─────────── */
async function resolveRD(url){
  try{
    const r = await fetchFn(url,{method:"HEAD",redirect:"manual",timeout:5000});
    return r.headers.get("location")||url;
  }catch{return url;}
}

/* ─────────── stream handler ─────────── */
builder.defineStreamHandler(async ({type,id,config,headers})=>{
  const ua   = (headers?.["user-agent"]||"").toLowerCase();
  const isTV = ua.includes("android")||ua.includes("crkey")||ua.includes("smarttv");

  let src=config?.sourceAddonUrl||userConfigs.default||DEFAULT_SOURCE;
  if(config?.sourceAddonUrl) userConfigs.default = config.sourceAddonUrl;
  if(src.startsWith("stremio://")) src = src.replace("stremio://","https://");

  const tURL=`${src.replace(/\/manifest\.json$/,"")}/stream/${type}/${id}.json`;
  console.log("🔗",tURL);

  let streams=[];
  try{
    const r=await fetchFn(tURL,{timeout:5000});
    if(r.ok){
      const {streams:raw=[]}=await r.json();
      streams=await Promise.all(raw.map(async(st,i)=>{
        if(st.url?.includes("/resolve/realdebrid/")){
          const cdn=await resolveRD(st.url);
          st.url=`/proxy?u=${encodeURIComponent(cdn)}`; // same host
        }
        const rdTag = st.name.match(/\[RD[^\]]*\]/)?.[0]||"[RD]";
        return {
          ...st,
          name : `${rdTag} Stream ${i+1}`,
          title: "Generic Stream",
          description:`Stream ${i+1}`,
          behaviorHints:{...(st.behaviorHints||{}),filename:`Stream_${i+1}.mp4`}
        };
      }));
    }
  }catch(e){console.error("Fetch fail:",e.message);}

  if(isTV&&streams.length===0){
    streams.push({name:"[RD] Stream 1",url:FALLBACK_MP4,behaviorHints:{filename:"Fallback.mp4"}});
  }
  return {streams};
});

/* ─────────── Express server ─────────── */
const app    = express();
const server = http.createServer(app);

/* /proxy keeps same origin */
app.get("/proxy",(req,res)=>{
  const u=req.query.u;
  if(!u) return res.status(400).send("missing u");
  res.redirect(302,u);
});

/* simple /configure page */
app.get("/configure",(req,res)=>{
  res.type("html").send(`
<!doctype html>
<title>Universal Stream Renamer – Configure</title>
<h2>How to configure</h2>
<ol>
  <li>In Stremio, click the gear icon next to this add‑on.</li>
  <li>Paste the <b>Torrentio manifest URL</b> you generated (with your Real‑Debrid token).</li>
  <li>Save. Streams will reload with generic names.</li>
</ol>
<p>No additional web configuration is required.</p>
`);
});

/* mount Stremio interface */
app.use("/", getRouter(builder.getInterface()));

/* start */
server.listen(PORT,()=>{
  const url = process.env.RENDER_EXTERNAL_URL||`http://127.0.0.1:${PORT}`;
  console.log("🚀 Universal Stream Renamer:",`${url}/manifest.json`);
});
