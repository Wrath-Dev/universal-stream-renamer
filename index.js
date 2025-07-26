/**************************************************************************
 * UNIVERSAL STREAM RENAMER – 4.0.4
 * • Renames ONLY Real‑Debrid streams on desktop
 * • Leaves all other stream names untouched
 **************************************************************************/

const express                     = require("express");
const http                        = require("http");
const { addonBuilder, getRouter } = require("stremio-addon-sdk");

const PORT = process.env.PORT || 10000;
const DEFAULT_SOURCE = "https://torrentio.strem.fun/manifest.json";
const FALLBACK_MP4   = "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4";

/* manifest */
const manifest = {
  id: "org.universal.stream.renamer",
  version: "4.0.4",
  name: "Universal Stream Renamer",
  description: "Renames only Real‑Debrid streams; Chromecast‑safe proxy.",
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
  if(config?.sourceAddonUrl) userConfigs.default = src;
  if(src.startsWith("stremio://")) src = src.replace("stremio://","https://");

  const base = new URL(src);
  const api  = `${base.origin}/stream/${type}/${id}.json${base.search}`;
  console.log("🔗", api);

  let streams=[];
  try{
    const r=await fetch(api,{timeout:5000});
    if(r.ok){
      const raw=(await r.json()).streams || [];

      streams = await Promise.all(raw.map(async (s,i)=>{
        const cameFromRD = s.url?.includes("/resolve/realdebrid/");

        /* resolve RD once */
        if(cameFromRD) s.url = await resolveRD(s.url);

        /* TV/Chromecast: wrap every URL */
        if(isTV) s.url = `/proxy?u=${encodeURIComponent(s.url)}`;

        /* Desktop/Web: rename only RD streams */
        if(!isTV && cameFromRD){
          const tag = s.name.match(/\[RD[^\]]*\]/)?.[0] || "[RD]";
          s = { ...s, name:`${tag} Stream ${i+1}` };
        }
        return s;
      }));
    }
  }catch(e){ console.error("torrentio fail", e.message); }

  /* fallback for TV */
  if(isTV && streams.length===0)
    streams.push({ name:"Fallback MP4",
                   url:`/proxy?u=${encodeURIComponent(FALLBACK_MP4)}`,
                   behaviorHints:{ filename:"Fallback.mp4" } });

  return { streams };
});

/* express app */
const app = express();

/* configure page */
app.get("/configure",(req,res)=>{
  const base=`https://${req.get("host")}/manifest.json`;
  res.type("html").send(`
<input id=src style="width:100%;padding:.6rem" placeholder="${DEFAULT_SOURCE}">
<button onclick="copy()">Copy manifest URL</button>
<script>
function copy(){
  const v=document.getElementById('src').value.trim();
  const url=v? '${base}?sourceAddonUrl=' + encodeURIComponent(v) : '${base}';
  navigator.clipboard.writeText(url).then(()=>alert('Copied manifest URL to clipboard.'));
}
</script>`);
});
app.get("/",(_q,r)=>r.redirect("/configure"));

/* same‑origin proxy */
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

/* start */
http.createServer(app).listen(PORT, ()=>console.log("🚀 addon on", PORT));
