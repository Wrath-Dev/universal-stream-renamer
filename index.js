/**************************************************************************
 * UNIVERSAL STREAM RENAMER – clean numbered names on desktop
 **************************************************************************/

const express                     = require("express");
const http                        = require("http");
const { addonBuilder, getRouter } = require("stremio-addon-sdk");

const PORT           = process.env.PORT || 10000;
const DEFAULT_SOURCE = "https://torrentio.strem.fun/manifest.json";
const FALLBACK_MP4   = "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4";

const manifest = {
  id: "org.universal.stream.renamer",
  version: "4.1.0",
  name: "Universal Stream Renamer",
  description: "Clean numbered names on desktop; Chromecast‑safe proxy.",
  resources: ["stream"],
  types: ["movie", "series"],
  idPrefixes: ["tt"],
  catalogs: [],
  config: [{ key:"sourceAddonUrl", type:"text", title:"Source Add‑on Manifest URL" }],
  behaviorHints: { configurable: true }
};

const builder     = new addonBuilder(manifest);
const userConfigs = {};

/* follow one RD redirect */
async function resolveRD(u){
  try{
    const r = await fetch(u,{method:"HEAD",redirect:"manual",timeout:4000});
    return r.headers.get("location") || u;
  }catch{return u;}
}

/* stream handler */
builder.defineStreamHandler(async ({type,id,config,headers})=>{
  const ua   = (headers?.["user-agent"]||"").toLowerCase();
  const isTV = ua.includes("android") || ua.includes("crkey") || ua.includes("smarttv");

  let src=config?.sourceAddonUrl || userConfigs.default || DEFAULT_SOURCE;
  if (config?.sourceAddonUrl) userConfigs.default = src;
  if (src.startsWith("stremio://")) src = src.replace("stremio://","https://");

  const base = new URL(src);
  const api  = `${base.origin}/stream/${type}/${id}.json${base.search}`;
  console.log("🔗", api);

  let streams=[];
  try{
    const r=await fetch(api,{timeout:5000});
    if(r.ok){
      const raw=(await r.json()).streams || [];

      let counter = 1;
      streams = await Promise.all(raw.map(async s=>{
        const fromRD = s.url?.includes("/resolve/realdebrid/");
        if(fromRD) s.url = await resolveRD(s.url);

        /* wrap for TV */
        if(isTV){
          s.url = `/proxy?u=${encodeURIComponent(s.url)}`;
          return s;                           // keep original name on TV
        }

        /* desktop/web – give a clean unique name */
        const tag = fromRD ? "[RD] " : "";
        const clean = {
          ...s,
          name : `${tag}Stream ${counter++}`,
          behaviorHints:{ ...(s.behaviorHints||{}), filename:`Stream_${counter-1}.mp4` }
        };
        return clean;
      }));
    }
  }catch(e){ console.error("torrentio fail", e.message); }

  if(isTV && streams.length===0)
    streams.push({ name:"Fallback MP4",
                   url:`/proxy?u=${encodeURIComponent(FALLBACK_MP4)}`,
                   behaviorHints:{ filename:"Fallback.mp4" } });

  return { streams };
});

/* express app /configure + /proxy */
const app = express();

app.get("/configure",(req,res)=>{
  const base=`https://${req.get("host")}/manifest.json`;
  res.type("html").send(`
<input id=src style="width:100%;padding:.6rem" placeholder="${DEFAULT_SOURCE}">
<button onclick="copy()">Copy manifest URL</button>
<script>
function copy(){
  const v=document.getElementById('src').value.trim();
  const url=v? '${base}?sourceAddonUrl=' + encodeURIComponent(v) : '${base}';
  navigator.clipboard.writeText(url).then(()=>alert('Copied manifest URL'));
}
</script>`);
});
app.get("/",(_q,r)=>r.redirect("/configure"));

app.get("/proxy",(req,res)=>{
  try{
    const tgt=new URL(req.query.u);
    if(!/(real-debrid|debrid-link|rdt|cache)/i.test(tgt.hostname))
      return res.status(400).send("blocked");
    res.redirect(302,tgt);
  }catch{res.status(400).send("bad url");}
});

/* mount SDK router */
app.use("/", getRouter(builder.getInterface()));

/* start */
http.createServer(app).listen(PORT, ()=>console.log("🚀 addon on", PORT));
