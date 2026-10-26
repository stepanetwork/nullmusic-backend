const http = require('http');
const https = require('https');
const url = require('url');

const PORT = process.env.PORT || 10000;

function fetchJson(targetUrl, timeoutMs = 7000) {
  return new Promise((resolve, reject) => {
    const req = https.get(targetUrl, {
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
  });
}

function formatDuration(sec) {
  if (!sec || isNaN(sec)) return '—';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s < 10 ? '0' : ''}${s}`;
}

const server = http.createServer(async (req, res) => {
  // CORS-заголовки для работы с фронтендом
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  const parsedUrl = url.parse(req.url, true);

  // Health-check для Render
  if (parsedUrl.pathname === '/' || parsedUrl.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ status: 'ok', uptime: process.uptime() }));
  }

  // Основной эндпоинт поиска
  if (parsedUrl.pathname === '/api/search') {
    const query = parsedUrl.query.q;
    if (!query || !query.trim()) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ tracks: [], error: 'Query is required' }));
    }

    const cleanQuery = query.trim();
    let tracks = [];

    // Список публичных открытых API-зеркал для поиска музыки
    const searchEndpoints = [
      `https://pipedapi.kavin.rocks/search?q=${encodeURIComponent(cleanQuery)}&filter=music_songs`,
      `https://api.piped.privacy.com.de/search?q=${encodeURIComponent(cleanQuery)}&filter=music_songs`,
      `https://pipedapi.tokhmi.xyz/search?q=${encodeURIComponent(cleanQuery)}&filter=music_songs`
    ];

    for (const endpoint of searchEndpoints) {
      try {
        const data = await fetchJson(endpoint, 5000);
        const items = data.items || (Array.isArray(data) ? data : []);

        if (items.length > 0) {
          tracks = items
            .filter(item => item.title && (item.url || item.id))
            .slice(0, 25)
            .map(item => {
              const id = item.url ? item.url.replace('/watch?v=', '') : (item.id || '');
              const durSec = item.duration || 180;
              let thumb = item.thumbnail || '';
              if (thumb.startsWith('//')) thumb = 'https:' + thumb;

              return {
                id: id,
                title: item.title,
                artist: item.uploaderName || item.uploader || 'Исполнитель',
                duration: formatDuration(durSec),
                rawDuration: durSec,
                cover: thumb ? `https://images.weserv.nl/?url=${encodeURIComponent(thumb.replace(/^https?:\/\//, ''))}&w=400&h=400&fit=cover` : '',
                streamUrl: `https://pipedproxy.kavin.rocks/api/v1/stream/${id}`
              };
            });

          if (tracks.length > 0) break;
        }
      } catch (err) {
        // Пробуем следующее зеркало при ошибке
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
  console.log(`Server listening on port ${PORT}`);
});
