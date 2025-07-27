const { addonBuilder, serveHTTP } = require("stremio-addon-sdk");
const DEFAULT_SOURCE = "https://torrentio.strem.fun/manifest.json";
const FALLBACK_MP4   = "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4";

const manifest = {
  id: "org.universal.stream.renamer",
  version: "2.2.1",
  name: "Universal Stream Renamer",
  description: "Renames Torrentio streams for desktop; leaves RD tags intact for Android‑TV / Chromecast.",
  resources: ["stream"],
  types: ["movie", "series"],
  idPrefixes: ["tt"],
  catalogs: [],
  config: [
    { key: "sourceAddonUrl", type: "text", title: "Source Add‑on Manifest URL", required: false }
  ],
  behaviorHints: { configurable: true }
};

const builder = new addonBuilder(manifest);
const userConfigs = {};

/* helper: follow one RD redirect and return final CDN URL */
async function resolveRD(rdUrl) {
  try {
    const res = await fetch(rdUrl, { method: "HEAD", redirect: "manual", timeout: 4000 });
    return res.headers.get("location") || rdUrl;
  } catch { return rdUrl; }
}

builder.defineStreamHandler(async ({ type, id, config, headers }) => {
  const ua   = (headers?.["user-agent"] || "").toLowerCase();
  const isTV = ua.includes("android") || ua.includes("crkey") || ua.includes("smarttv");

  let src = config?.sourceAddonUrl || userConfigs.default || DEFAULT_SOURCE;
  if (config?.sourceAddonUrl) userConfigs.default = config.sourceAddonUrl;
  if (src.startsWith("stremio://")) src = src.replace("stremio://", "https://");

  const tUrl = `${src.replace(/\/manifest\.json$/, "")}/stream/${type}/${id}.json`;
  console.log(`🔗 Fetching ${tUrl}`);

  let streams = [];
  try {
    const r = await fetch(tUrl, { timeout: 4000 });
    if (r.ok) {
      const { streams: raw = [] } = await r.json();

      streams = await Promise.all(
        raw.map(async (st, i) => {
          /* resolve RD redirect */
          if (st.url && st.url.includes("/resolve/realdebrid/"))
            st.url = await resolveRD(st.url);

          /* rename ONLY for desktop/web */
          if (!isTV) {
            const rdTag = st.name.includes("[RD") ? st.name.match(/\[RD[^\]]*\]/)[0] : "[RD]";
            st = {
              ...st,
              name : `${rdTag} Stream ${i + 1}`,
              title: "Generic Stream",
              description: `Stream ${i + 1}`,
              behaviorHints: {
                ...(st.behaviorHints || {}),
                filename: `Stream_${i + 1}.mp4`
              }
            };
          }
          return st;
        })
      );
    }
  } catch (e) {
    console.error("⚠️ Torrentio fetch failed:", e.message);
  }

  /* fallback only when TV and list empty */
  if (isTV && streams.length === 0) {
    streams.push({
      name : "Direct MP4 (Test)",
      title: "Fallback Stream",
      url  : FALLBACK_MP4,
      behaviorHints: { filename: "Fallback.mp4" }
    });
  }

  return { streams };
});

const PORT = process.env.PORT || 7001;
serveHTTP(builder.getInterface(), { port: PORT });

const external = process.env.RENDER_EXTERNAL_URL || `http://127.0.0.1:${PORT}`;
console.log(`🚀 Universal Stream Renamer available at: ${external}/manifest.json`);
