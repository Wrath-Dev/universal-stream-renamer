/**************************************************************************
 * UNIVERSAL STREAM RENAMER – 4.3.0
 * • No RD resolving in stream handler (fast lists)
 * • Resolve once in /proxy + in‑memory cache
 * • Clean names on desktop; original on TV/Chromecast
 **************************************************************************/

const express                     = require("express");
const http                        = require("http");
const { addonBuilder, getRouter } = require("stremio-addon-sdk");

const PORT           = process.env.PORT || 10000;
const DEFAULT_SOURCE = "https://torrentio.strem.fun/manifest.json";
const FALLBACK_MP4   = "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4";

const manifest = {
  id: "org.universal.stream.renamer",
  version: "4.3.0",
  name: "Universal Stream Renamer",
  description: "Fast, clean names; resolve RD only on play; Chromecast‑safe proxy.",
  resources: ["stream"],
  types: ["movie", "series"],
  idPrefixes: ["tt"],
  catalogs: [],
  config: [{ key:"sourceAddonUrl", type:"text", title:"Source Add‑on Manifest URL" }],
  behaviorHints: { configurable: true }
};

const builder     = addonBuilder(manifest);
const userConfigs = Object.create(null);

/* ───────── caches ───────── */
const STREAM_TTL  = 60 * 1000;           // 60s cache for Torrentio answers
const RD_TTL      = 60 * 60 * 1000;      // 1h cache for RD final urls
const streamCache = new Map();           // key -> { ts, payload }
const rdCache     = new Map();           // rdUrl -> { ts, final }

/* follow one Real‑Debrid redirect, with cache */
async function resolveRD(url) {
  const cached = rdCache.get(url);
  const now = Date.now();
  if (cached && now - cached.ts < RD_TTL) return cached.final;

  try {
    const r = await fetch(url, { method: "HEAD", redirect: "manual", timeout: 4000 });
    const final = r.headers.get("location") || url;
    rdCache.set(url, { ts: now, final });
    return final;
  } catch {
    return url;
  }
}

/* detect TV/Chromecast robustly */
function isTVUA(ua = "") {
  ua = ua.toLowerCase();
  return /stremio.*(android|tv)|crkey|smarttv/.test(ua);
}

/* ───────── stream handler ───────── */
builder.defineStreamHandler(async ({ type, id, config, headers }) => {
  const ua   = headers?.["user-agent"] || "";
  const isTV = isTVUA(ua);

  let src = config?.sourceAddonUrl || userConfigs.default || DEFAULT_SOURCE;
  if (config?.sourceAddonUrl) userConfigs.default = src;
  if (src.startsWith("stremio://")) src = src.replace("stremio://", "https://");

  const u    = new URL(src);
  const key  = `${type}:${id}:${u.search}`;
  const now  = Date.now();

  /* serve cached stream list quickly */
  const cached = streamCache.get(key);
  if (cached && now - cached.ts < STREAM_TTL) return cached.payload;

  const api = `${u.origin}/stream/${type}/${id}.json${u.search}`;
  console.log("🔗", api);

  let streams = [];
  try {
    const r = await fetch(api, { timeout: 5000 });
    if (r.ok) {
      const raw = (await r.json()).streams || [];
      let i = 1;

      streams = raw.map(s => {
        if (isTV) {
          // TV: keep original names, just wrap every URL in proxy
          return { ...s, url: `/proxy?u=${encodeURIComponent(s.url)}` };
        }

        // Desktop/Web: clean label + filename
        const fromRD   = s.url?.includes("/resolve/realdebrid/");
        const tag      = fromRD ? "[RD] " : "";
        const label    = `${tag}Stream ${i++}`;
        return {
          ...s,
          name : label,
          title: label,
          behaviorHints: {
            ...(s.behaviorHints || {}),
            filename: label.replace(/\s+/g, "_") + ".mp4"
          }
        };
      });
    }
  } catch (e) {
    console.error("torrentio fetch failed:", e.message);
  }

  if (isTV && streams.length === 0) {
    streams.push({
      name : "Fallback MP4",
      url  : `/proxy?u=${encodeURIComponent(FALLBACK_MP4)}`,
      behaviorHints: { filename: "Fallback.mp4" }
    });
  }

  const payload = { streams };
  streamCache.set(key, { ts: now, payload });
  return payload;
});

/* ───────── express app ───────── */
const app = express();

/* resolve on-demand here (only for the stream actually played) */
app.get("/proxy", async (req, res) => {
  const target = req.query.u;
  try {
    const rd = new URL(target);
    if (!/(real-debrid|debrid-link|rdt|cache)/i.test(rd.hostname))
      return res.status(400).send("blocked");

    const final = target.includes("/resolve/realdebrid/")
      ? await resolveRD(target)
      : target;

    res.redirect(302, final);
  } catch {
    res.status(400).send("bad url");
  }
});

/* minimal configure page */
app.get("/configure", (req, res) => {
  const base = `https://${req.get("host")}/manifest.json`;
  res.type("html").send(`
<!doctype html><meta charset=utf-8>
<title>Universal Stream Renamer – Configure</title>
<input id=src style="width:100%;padding:.6rem" placeholder="${DEFAULT_SOURCE}">
<button onclick="copy()">Copy manifest URL</button>
<script>
function copy(){
  const v=document.getElementById('src').value.trim();
  const url=v? '${base}?sourceAddonUrl=' + encodeURIComponent(v) : '${base}';
  navigator.clipboard.writeText(url).then(()=>alert('Copied!')).catch(()=>alert(url));
}
</script>`);
});
app.get("/", (_q, r) => r.redirect("/configure"));

/* Stremio SDK router */
app.use("/", getRouter(builder.getInterface()));

/* start */
http.createServer(app).listen(PORT, () => {
  console.log("🚀 Add‑on listening on", PORT);
});
