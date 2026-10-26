const http = require('http');
const https = require('https');
const url = require('url');

const PORT = process.env.PORT || 10000;

// Надёжный асинхронный fetch с тайм-аутом и редиректами
function fetchJson(targetUrl, timeoutMs = 6000) {
  return new Promise((resolve, reject) => {
    try {
      const parsed = new URL(targetUrl);
      const req = https.get({
        hostname: parsed.hostname,
        path: parsed.pathname + parsed.search,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          'Accept': 'application/json, text/plain, */*'
        }
      }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return resolve(fetchJson(res.headers.location, timeoutMs));
        }
        if (res.statusCode !== 200) {
          return reject(new Error(`HTTP Status ${res.statusCode}`));
        }
        let raw = '';
        res.on('data', chunk => raw += chunk);
        res.on('end', () => {
          try {
            resolve(JSON.parse(raw));
          } catch (e) {
            reject(e);
          }
        });
      });
      req.on('error', reject);
      req.setTimeout(timeoutMs, () => {
        req.abort();
        reject(new Error('Timeout'));
      });
    } catch (err) {
      reject(err);
    }
  });
}

function formatDuration(sec) {
  if (!sec || isNaN(sec)) return '—';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s < 10 ? '0' : ''}${s}`;
}

const server = http.createServer(async (req, res) => {
  // CORS-заголовки для прямого подключения мобильного клиента
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  const parsedUrl = url.parse(req.url, true);

  // Health-check для индикатора статуса
  if (parsedUrl.pathname === '/' || parsedUrl.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ status: 'ok', uptime: process.uptime() }));
  }

  // Поисковый эндпоинт
  if (parsedUrl.pathname === '/api/search') {
    const query = parsedUrl.query.q;
    if (!query || !query.trim()) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ tracks: [], error: 'Query is required' }));
    }

    const cleanQuery = query.trim();
    let tracks = [];

    // 1. Поиск полных аудиопотоков через открытые узлы Audius Discovery
    const audiusHosts = [
      'https://discoveryprovider.audius.co',
      'https://discoveryprovider2.audius.co',
      'https://discoveryprovider3.audius.co'
    ];

    let audiusStreams = [];
    for (const host of audiusHosts) {
      try {
        const aData = await fetchJson(`${host}/v1/tracks/search?query=${encodeURIComponent(cleanQuery)}&app_name=nullmusic`, 4000);
        if (aData && Array.isArray(aData.data) && aData.data.length > 0) {
          audiusStreams = aData.data.map(item => ({
            id: item.id,
            title: item.title || 'Без названия',
            artist: (item.user && item.user.name) ? item.user.name : 'Исполнитель',
            duration: formatDuration(item.duration || 180),
            rawDuration: item.duration || 180,
            cover: (item.artwork && (item.artwork['480x480'] || item.artwork['150x150'])) || '',
            streamUrl: `${host}/v1/tracks/${item.id}/stream?app_name=nullmusic`
          }));
          break;
        }
      } catch (e) {
        continue;
      }
    }

    // 2. Поиск точного каталога артистов и оригинальных HD-обложек
    try {
      const catUrl = `https://itunes.apple.com/search?term=${encodeURIComponent(cleanQuery)}&country=RU&media=music&entity=song&limit=25`;
      const catData = await fetchJson(catUrl, 4500);
      if (catData && Array.isArray(catData.results) && catData.results.length > 0) {
        tracks = catData.results.map((item, idx) => {
          const durSec = item.trackTimeMillis ? Math.round(item.trackTimeMillis / 1000) : 180;
          const hiResCover = item.artworkUrl100 ? item.artworkUrl100.replace('100x100bb', '600x600bb') : '';
          const matchedStream = audiusStreams[idx] ? audiusStreams[idx].streamUrl : '';

          return {
            id: String(item.trackId || idx),
            title: item.trackName || 'Без названия',
            artist: item.artistName || 'Исполнитель',
            duration: formatDuration(durSec),
            rawDuration: durSec,
            cover: hiResCover,
            streamUrl: matchedStream || item.previewUrl || '',
            backupUrl: item.previewUrl || ''
          };
        });
      }
    } catch (e) {}

    if (tracks.length === 0 && audiusStreams.length > 0) {
      tracks = audiusStreams;
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ tracks }));
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`nullmusic server running on port ${PORT}`);
});
