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

    // Список актуальных поисковых зеркал с открытым API
    const endpoints = [
      `https://invidious.nerdvpn.de/api/v1/search?q=${encodeURIComponent(cleanQuery)}&type=video`,
      `https://inv.nadeko.net/api/v1/search?q=${encodeURIComponent(cleanQuery)}&type=video`,
      `https://invidious.drgns.space/api/v1/search?q=${encodeURIComponent(cleanQuery)}&type=video`,
      `https://pipedapi.kavin.rocks/search?q=${encodeURIComponent(cleanQuery)}&filter=music_songs`
    ];

    for (const ep of endpoints) {
      try {
        const data = await fetchJson(ep, 4500);
        const items = Array.isArray(data) ? data : (data.items || []);

        if (items.length > 0) {
          tracks = items
            .filter(item => item.title && (item.videoId || item.url || item.id))
            .slice(0, 25)
            .map(item => {
              const id = item.videoId || (item.url ? item.url.replace('/watch?v=', '') : item.id);
              const durSec = item.lengthSeconds || item.duration || 180;
              
              let thumb = '';
              if (item.videoThumbnails && item.videoThumbnails.length > 0) {
                thumb = item.videoThumbnails[item.videoThumbnails.length - 1].url;
              } else if (item.thumbnail) {
                thumb = item.thumbnail;
              } else {
                thumb = `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;
              }
              if (thumb.startsWith('//')) thumb = 'https:' + thumb;

              const cleanThumb = thumb.replace(/^https?:\/\//, '');

              return {
                id: id,
                title: item.title,
                artist: item.author || item.uploaderName || item.uploader || 'Исполнитель',
                duration: formatDuration(durSec),
                rawDuration: durSec,
                cover: `https://images.weserv.nl/?url=${encodeURIComponent(cleanThumb)}&w=500&h=500&fit=cover`,
                streamUrl: `https://invidious.nerdvpn.de/latest_version?id=${id}&itag=140`
              };
            });

          if (tracks.length > 0) break;
        }
      } catch (err) {
        // Пробуем следующее зеркало
        continue;
      }
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
