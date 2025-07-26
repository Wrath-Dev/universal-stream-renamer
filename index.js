/**************************************************************************
 * UNIVERSAL STREAM RENAMER – 4.2.0  (Render / production)
 **************************************************************************/

const express                     = require("express");
const http                        = require("http");
const { addonBuilder, getRouter } = require("stremio-addon-sdk");

const PORT           = process.env.PORT || 10000;   // Render injects PORT
const DEFAULT_SOURCE = "https://torrentio.strem.fun/manifest.json";
const FALLBACK_MP4   = "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4";

/* ─────────── manifest ─────────── */
const manifest = {
  id          : "org.universal.stream.renamer",
  version     : "4.2.0",
  name        : "Universal Stream Renamer",
  description : "Clean, numbered stream names on desktop; Chromecast‑safe proxy.",
  resources   : ["stream"],
  types       : ["movie", "series"],
  idPrefixes  : ["tt"],
  catalogs    : [],
  config      : [{ key:"sourceAddonUrl", type:"text", title:"Source Add‑on Manifest URL" }],
  behaviorHints: { configurable: true }
};

const builder     = addonBuilder(manifest);
const userConfigs = Object.create(null);

/* follow one Real‑Debrid redirect */
async function resolveRD (url) {
  try {
    const r = await fetch(url, { method:"HEAD", redirect:"manual", timeout:4000 });
    return r.headers.get("location") || url;
  } catch { return url; }
}

/* ─────────── STREAM HANDLER ─────────── */
builder.defineStreamHandler(async ({ type, id, config, headers }) => {
  const ua   = (headers?.["user-agent"] || "").toLowerCase();
  const isTV = /stremio.*(android|tv)|crkey|smarttv/.test(ua);

  let src = config?.sourceAddonUrl || userConfigs.default || DEFAULT_SOURCE;
  if (config?.sourceAddonUrl) userConfigs.default = src;
  if (src.startsWith("stremio://")) src = src.replace("stremio://", "https://");

  const srcURL = new URL(src);
  const apiURL = `${srcURL.origin}/stream/${type}/${id}.json${srcURL.search}`;
  console.log("🔗", apiURL);

  const r = await fetch(apiURL, { timeout:5000 }).catch(() => null);
  if (!r?.ok) return { streams: [] };

  const rawStreams = (await r.json()).streams || [];
  let idx = 1;

  const streams = await Promise.all(rawStreams.map(async s => {
    const isRD = s.url?.includes("/resolve/realdebrid/");

    /* Resolve RD once */
    if (isRD) s.url = await resolveRD(s.url);

    /* Wrap for TV / Chromecast */
    if (isTV) {
      s.url = `/proxy?u=${encodeURIComponent(s.url)}`;
      return s;                        // keep original names on TV
    }

    /* Desktop / Web – clean name + title + filename */
    const tag     = isRD ? "[RD] " : "";
    const label   = `${tag}Stream ${idx++}`;
    return {
      ...s,
      name : label,
      title: label,
      behaviorHints: {
        ...(s.behaviorHints || {}),
        filename: label.replace(/\s+/g, "_") + ".mp4"
      }
    };
  }));

  /* TV fallback if list empty */
  if (isTV && streams.length === 0) {
    streams.push({
      name : "Fallback MP4",
      url  : `/proxy?u=${encodeURIComponent(FALLBACK_MP4)}`,
      behaviorHints:{ filename:"Fallback.mp4" }
    });
  }

  return { streams };
});

/* ─────────── EXPRESS APP ─────────── */
const app = express();

/* /configure – minimal helper page */
app.get("/configure", (req, res) => {
  const host = req.get("host");
  const base = `https://${host}/manifest.json`;
  res.type("html").send(`
<!doctype html><meta charset=utf-8>
<title>Universal Stream Renamer – Configure</title>
<input id=src style="width:100%;padding:.6rem" placeholder="${DEFAULT_SOURCE}">
<button onclick="copy()">Copy manifest URL</button>
<script>
function copy(){
  const inp = document.getElementById('src').value.trim();
  const url = inp ? '${base}?sourceAddonUrl=' + encodeURIComponent(inp) : '${base}';
  navigator.clipboard.writeText(url).then(()=>alert('Copied:\\n'+url));
}
</script>`);
});
app.get("/", (_q, r) => r.redirect("/configure"));

/* Same‑origin proxy for TV */
app.get("/proxy", (req, res) => {
  try {
    const tgt = new URL(req.query.u);
    if (!/(real-debrid|debrid-link|rdt|cache)/i.test(tgt.hostname))
      return res.status(400).send("blocked");
    res.redirect(302, tgt);
  } catch { res.status(400).send("bad url"); }
});

/* Stremio SDK router – /manifest.json & /stream/... */
app.use("/", getRouter(builder.getInterface()));

/* ─────────── START SERVER ─────────── */
http.createServer(app).listen(PORT, () => {
  console.log("🚀 Add‑on listening on port", PORT);
});
