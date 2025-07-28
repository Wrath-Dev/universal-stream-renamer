// index.js  –  Universal Stream Renamer (lightweight RD version)
// --------------------------------------------------------------

import express from 'express';
import http from 'http';
import fetch from 'node-fetch';
import { addonBuilder, getRouter } from 'stremio-addon-sdk';

const PORT           = process.env.PORT || 10000;
const FALLBACK_MP4   =
  'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4';

/* ───────────── manifest ───────────── */
const manifest = {
  id          : 'org.universal.stream.renamer',
  version     : '4.0.0',
  name        : 'Universal Stream Renamer',
  description : 'Shows Real‑Debrid direct links from Torrentio and hides long titles.',
  resources   : ['stream'],
  types       : ['movie', 'series'],
  idPrefixes  : ['tt'],
  catalogs    : [],
  config      : [
    { key: 'sourceAddonUrl',
      type: 'text',
      title: 'Source Add‑on Manifest URL (your Torrentio link)',
      required: true }
  ],
  behaviorHints: { configurable: true }
};

const builder     = new addonBuilder(manifest);
const userConfigs = Object.create(null);

/* ───────── helper: same‑origin redirect for Chromecast ───────── */
function needsProxy(ua) {
  if (!ua) return true;                // Chromecast sends almost nothing
  ua = ua.toLowerCase();
  return ua.includes('android') ||
         ua.includes('crkey')  ||
         ua.includes('smarttv');
}

/* ───────── stream handler ───────── */
builder.defineStreamHandler(async ({ type, id, config, headers }) => {
  const ua   = headers?.['user-agent'] || '';
  const isTV = needsProxy(ua);

  // 1. work out which Torrentio manifest to call
  let src = config?.sourceAddonUrl || userConfigs.default;
  if (!src)
    return { streams: [] };                    // addon not configured yet

  if (config?.sourceAddonUrl) userConfigs.default = src;
  if (src.startsWith('stremio://')) src = src.replace('stremio://', 'https://');

  const url = `${src.replace(/\/manifest\.json$/, '')}/stream/${type}/${id}.json`;

  /* 2. fetch Torrentio */
  const res   = await fetch(url);
  const json  = await res.json();
  const raw   = Array.isArray(json.streams) ? json.streams : [];

  /* 3. keep only direct links (url present) */
  const direct = raw.filter(s => typeof s.url === 'string' && s.url.startsWith('http'));

  /* 4. map / rename */
  const streams = direct.map((st, i) => ({
    name : `[RD] Stream ${i + 1}`,
    title: `[RD] Stream ${i + 1}`,
    url  : isTV ? `/proxy?u=${encodeURIComponent(st.url)}` : st.url,
    behaviorHints: {
      filename: `Stream_${i + 1}.mp4`
    }
  }));

  /* 5. fallback for TV if nothing */
  if (isTV && !streams.length) {
    streams.push({
      name : 'Fallback MP4',
      title: 'Fallback Stream',
      url  : `/proxy?u=${encodeURIComponent(FALLBACK_MP4)}`,
      behaviorHints: { filename: 'Fallback.mp4' }
    });
  }

  return { streams };
});

/* ───────── minimal Express wrapper ───────── */
const app = express();

app.get('/proxy', (req, res) => {
  const target = req.query.u;
  // allow only http/https just to be safe
  try {
    const { protocol } = new URL(target);
    if (!['http:', 'https:'].includes(protocol)) throw 'bad proto';
    res.redirect(302, target);
  } catch {
    res.status(400).send('invalid url');
  }
});

app.get('/', (_req, res) => res.redirect('/configure'));
app.use('/', getRouter(builder.getInterface()));

/* ───────── start ───────── */
http.createServer(app).listen(PORT, () =>
  console.log(`🚀 addon ready at http://127.0.0.1:${PORT}/manifest.json\n` +
              `ℹ︎ open /configure in a browser to enter your Torrentio link`)
);
