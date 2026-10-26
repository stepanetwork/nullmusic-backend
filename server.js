const http = require('http');
const https = require('https');
const url = require('url');

const PORT = process.env.PORT || 10000;

function fetchJson(targetUrl, timeoutMs = 6000) {
  return new Promise((resolve, reject) => {
    try {
      const parsed = new URL(targetUrl);
      const req = https.get({
        hostname: parsed.hostname,
        path: parsed.pathname + parsed.search,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124.0.0.0 Safari/537.36',
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

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  const parsedUrl = url.parse(req.url, true);

  if (parsedUrl.pathname === '/' || parsedUrl.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ status: 'ok', uptime: process.uptime() }));
  }

  // Поиск через публичные шлюзы Invidious / Piped (YouTube Music бэкенд)
  if (parsedUrl.pathname === '/api/search') {
    const query = parsedUrl.query.q;
    if (!query || !query.trim()) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ tracks: [], error: 'Query is required' }));
    }

    const cleanQuery = query.trim();
    const instances = [
      'https://vid.puffyan.us',
      'https://invidious.nerdvpn.de',
      'https://inv.nadeko.net',
      'https://invidious.drgns.space'
    ];

    let foundTracks = [];

    for (const host of instances) {
      try {
        const searchUrl = `${host}/api/v1/search?q=${encodeURIComponent(cleanQuery + ' music audio')}&type=video`;
        const data = await fetchJson(searchUrl, 4500);
        if (Array.isArray(data) && data.length > 0) {
          foundTracks = data
            .filter(item => item.videoId && item.lengthSeconds > 30)
            .slice(0, 25)
            .map(item => {
              const durSec = item.lengthSeconds || 180;
              const m = Math.floor(durSec / 60);
              const s = Math.floor(durSec % 60);
              const durationFormatted = `${m}:${s < 10 ? '0' : ''}${s}`;
              
              // Забираем качественную обложку из видеосервиса
              const coverUrl = `https://i.ytimg.com/vi/${item.videoId}/hqdefault.jpg`;

              return {
                id: item.videoId,
                title: item.title || 'Без названия',
                artist: item.author || 'Исполнитель',
                duration: durationFormatted,
                rawDuration: durSec,
                cover: coverUrl,
                // Используем надежный инди-стрим шлюз для извлечения аудиодорожки
                streamUrl: `https://co.wuk.sh/api/stream?url=https://www.youtube.com/watch?v=${item.videoId}`,
                backupUrl: `https://invidious.nerdvpn.de/latest_version?id=${item.videoId}&itag=251`
              };
            });
          if (foundTracks.length > 0) break;
        }
      } catch (e) {}
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ tracks: foundTracks }));
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`nullmusic yt-backend running on port ${PORT}`);
});
