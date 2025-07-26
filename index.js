/**************************************************************************
 * UNIVERSAL STREAM RENAMER – diag build (logs UA + proxy usage)
 **************************************************************************/

const express = require("express");
const http    = require("http");
const { addonBuilder, getRouter } = require("stremio-addon-sdk");
const AbortController = global.AbortController || require("abort-controller");

const PORT           = process.env.PORT || 10000;
const DEFAULT_SOURCE = "https://torrentio.strem.fun/manifest.json";

/* manifest */
const manifest = {
  id:"org.universal.stream.renamer",
  version:"4.2.3-dbg",
  name:"USR diag",
  resources:["stream"], types:["movie","series"], idPrefixes:["tt"],
  catalogs:[], behaviorHints:{ configurable:true }
};
const builder = addonBuilder(manifest);

/* STREAM HANDLER */
builder.defineStreamHandler(async ({type,id,config,headers})=>{
  const ua = (headers && headers["user-agent"]) ? headers["user-agent"] : "<no UA>";
  const isTV = /(exoplayer|stagefright|dalvik|android tv|shield|bravia|crkey|smarttv)/i.test(ua);
  const src = (config?.sourceAddonUrl || DEFAULT_SOURCE).replace("stremio://","https://");
  const api = `${new URL(src).origin}/stream/${type}/${id}.json${new URL(src).search}`;

  console.log("\nUA:", ua);        // 1️⃣  full UA

  /* fetch Torrentio (2 s timeout) */
  const ctrl=new AbortController(); setTimeout(()=>ctrl.abort(),2000);
  const r = await fetch(api,{signal:ctrl.signal}).catch(()=>null);
  const raw = r?.ok ? (await r.json()).streams || [] : [];

  let idx=1;
  const streams = raw.slice(0,isTV?10:raw.length).map(s=>{
    const fromRD = s.url?.includes("/resolve/realdebrid/");
    if(isTV){
      const wrapped = `/proxy?u=${encodeURIComponent(s.url)}`;
      console.log(`TV? ${isTV}  WRAPPED? true  EXAMPLE: ${wrapped.slice(0,60)}…`); // 2️⃣
      return {...s, url:wrapped};
    }
    const tag = fromRD ? "[RD] " : "";
    const label = `${tag}Stream ${idx++}`;
    console.log(`TV? ${isTV}  WRAPPED? false  EXAMPLE: ${label}`); // 2️⃣ desktop line
    return {...s, name:label, title:label};
  });
  return {streams};
});

/* EXPRESS APP with /proxy debug */
const app = express();
app.get("/proxy",(req,res)=>{
  const tgt = req.query.u;
  console.log("/proxy hit 302 →", decodeURIComponent(tgt).slice(0,80)+"…"); // 3️⃣
  res.redirect(302,tgt);
});
app.use("/", getRouter(builder.getInterface()));

/* start */
http.createServer(app).listen(PORT,()=>console.log("diag addon on",PORT));
