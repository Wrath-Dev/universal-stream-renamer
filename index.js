/**************************************************************************
 * UNIVERSAL STREAM RENAMER – “scraper” variant
 *
 *  • Relies on torrent‑io‑scraper to talk to RD
 *  • Still returns the simple Stream‑1 / Stream‑2 names you liked
 *  • Keeps Chromecast proxy + /configure working
 **************************************************************************/

import express          from "express";
import http             from "http";
import { addonBuilder, getRouter } from "stremio-addon-sdk";
import { scraper }      from "torrentio-scraper";          // <-- NEW
                                                           //     (default export changed to named in latest version)

/* ───────────────────────── manifest ───────────────────────── */

const PORT           = process.env.PORT || 10000;
const DEFAULT_SOURCE = "https://torrentio.strem.fun/manifest.json"; // only used if user leaves box empty
const FALLBACK_MP4   = "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4";

const manifest = {
  id:          "org.universal.stream.renamer",
  version:     "4.0.0",
  name:        "Universal Stream Renamer",
  description: "Torrentio‑scraper + Real‑Debrid → neat Stremio streams",
  resources :  ["stream"],
  types     :  ["movie","series"],
  idPrefixes:  ["tt"],
  catalogs  :  [],
  config    : [{
    key   : "sourceAddonUrl",
    type  : "text",
    title : "Torrentio manifest (incl. RD key)",
    required : false
  }],
  behaviorHints:{ configurable:true }
};

const builder = new addonBuilder(manifest);
const userConfigs = Object.create(null);

/* ───────────────────────── helper ───────────────────────── */

function isTV(ua="") {
  ua = ua.toLowerCase();
  return ua.includes("android") || ua.includes("crkey") || ua.includes("smarttv");
}

/* if you still want to keep the single‑hop redirect for TVs */
function sameOrigin(tv, finalUrl, host) {
  return tv
    ? `https://${host}/proxy?u=${encodeURIComponent(finalUrl)}`
    : finalUrl;
}

/* ───────────────── stream handler ───────────────── */

builder.defineStreamHandler(async ({type, id, config, headers})=>{
  const tv = isTV(headers?.["user-agent"]||"");

  /* where to scrape from   ────────── */
  let src = config?.sourceAddonUrl || userConfigs.default || DEFAULT_SOURCE;
  if (config?.sourceAddonUrl) userConfigs.default = src;
  if (src.startsWith("stremio://")) src = src.replace("stremio://","https://");

  /* call torrent‑io‑scraper (returns exactly the same JSON the
     Torrentio HTTP endpoint would give you, but *already enriched*
     with Real‑Debrid direct URLs if the key is present)             */
  const { streams: raw = [] } = await scraper.streams({
    manifestUrl : src,
    imdbId      : id,       // scraper figures out if it’s “tt123…” or “tt:season:episode”
    type
  }).catch(e=>{
    console.error("scraper error:", e.message||e);
    return { streams : [] };
  });

  /* translate to Stremio streams */
  const host = headers?.host || process.env.RENDER_EXTERNAL_HOSTNAME || `127.0.0.1:${PORT}`;

  const streams = raw
    .filter(s => s.url)               // ONLY keep ones that have a direct link
    .map((s, i) => ({
       name : `[RD] Stream ${i+1}`,
       title: `[RD] Stream ${i+1}`,
       url  : sameOrigin(tv, s.url, host),
       behaviorHints : { filename:`Stream_${i+1}.mp4` }
    }));

  /* fallback for TV w/ nothing */
  if (tv && streams.length===0) {
    streams.push({
      name:"Fallback",title:"Fallback",
      url : sameOrigin(tv, FALLBACK_MP4, host),
      behaviorHints:{ filename:"Fallback.mp4" }
    });
  }

  return { streams };
});

/* ───────────────── Express wiring (router FIRST!) ───────────────── */

const app = express();
app.use("/", getRouter(builder.getInterface()));

app.get("/proxy",(req,res)=>{
  const u=req.query.u;
  res.redirect(302,u);
});
app.get("/",(_req,res)=>res.redirect("/configure"));

http.createServer(app).listen(PORT, ()=>
  console.log(`🚀 add‑on ready on https://127.0.0.1:${PORT}/manifest.json`)
);
