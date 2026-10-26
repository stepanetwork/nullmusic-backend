const http = require('http');
const https = require('https');
const url = require('url');

const PORT = process.env.PORT || 10000;

// Зеркала для поиска
const MIRRORS = [
  'inv.nadeko.net',
  'invidious.private.coffee',
  'yewtu.be',
  'iv.melmac.space'
];

function fetchJson(targetUrl, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const req = https.get(targetUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
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

const server = http.createServer(async (req, res) => {
  // CORS заголовки
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  const parsedUrl = url.parse(req.url, true);

  // Проверка статуса
  if (parsedUrl.pathname === '/' || parsedUrl.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ status: 'ok', service: 'nullmusic core api' }));
  }

  // Поиск треков
  if (parsedUrl.pathname === '/api/search') {
    const query = parsedUrl.query.q;
    if (!query) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Query required' }));
    }

    // 1. Поиск по инстансам
    for (const host of MIRRORS) {
      try {
        const apiUrl = `https://${host}/api/v1/search?q=${encodeURIComponent(query)}&type=video`;
        const data = await fetchJson(apiUrl, 3500);

        if (Array.isArray(data) && data.length > 0) {
          const tracks = data
            .filter(v => v.lengthSeconds && v.lengthSeconds > 40 && v.lengthSeconds < 1200)
            .map(v => {
              const min = Math.floor(v.lengthSeconds / 60);
              const sec = v.lengthSeconds % 60;
              const thumb = (v.videoThumbnails && v.videoThumbnails.length > 0)
                ? v.videoThumbnails[v.videoThumbnails.length - 1].url
                : `https://images.weserv.nl/?url=i.ytimg.com/vi/${v.videoId}/hqdefault.jpg`;

              return {
                id: v.videoId,
                title: v.title,
                artist: v.author ? v.author.replace(' - Topic', '') : 'Артист',
                duration: `${min}:${sec < 10 ? '0' : ''}${sec}`,
                rawDuration: v.lengthSeconds,
                cover: thumb,
                streamUrl: `/api/stream/${v.videoId}`
              };
            });

          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ tracks }));
        }
      } catch (err) {
        // Пробуем следующее зеркало
      }
    }

    // Резервный поиск
    try {
      const itunesUrl = `https://itunes.apple.com/search?term=${encodeURIComponent(query)}&country=RU&media=music&limit=25`;
      const fallback = await fetchJson(itunesUrl, 3000);
      const fallbackTracks = (fallback.results || []).map(r => ({
        id: String(r.trackId),
        title: r.trackName,
        artist: r.artistName,
        duration: '3:00',
        rawDuration: 180,
        cover: r.artworkUrl100 ? r.artworkUrl100.replace('100x100bb', '500x500bb') : '',
        streamUrl: r.previewUrl
      }));

      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ tracks: fallbackTracks }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Search failed' }));
    }
  }

  // Прокси стрима
  if (parsedUrl.pathname.startsWith('/api/stream/')) {
    const videoId = parsedUrl.pathname.replace('/api/stream/', '');

    for (const host of MIRRORS) {
      try {
        const streamTarget = `https://${host}/latest_version?id=${videoId}&itag=140`;
        const proxyReq = https.get(streamTarget, (streamRes) => {
          if (streamRes.statusCode >= 200 && streamRes.statusCode < 400) {
            res.writeHead(200, { 'Content-Type': 'audio/mp4' });
            streamRes.pipe(res);
          }
        });
        proxyReq.on('error', () => {});
        return;
      } catch (e) {}
    }

    res.writeHead(502, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Stream unavailable' }));
  }

  res.writeHead(404);
  res.end();
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`nullmusic server running on port ${PORT}`);
});
