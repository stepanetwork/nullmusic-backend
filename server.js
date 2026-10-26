const http = require('http');
const https = require('https');
const url = require('url');

const PORT = process.env.PORT || 10000;

// Надежные активные инстансы для поиска и стриминга полных треков
const INVIDIOUS_HOSTS = [
  'inv.nadeko.net',
  'invidious.private.coffee',
  'yewtu.be',
  'iv.melmac.space'
];

function fetchJson(targetUrl, timeoutMs = 7000) {
  return new Promise((resolve, reject) => {
    const req = https.get(targetUrl, { 
      headers: { 
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' 
      } 
    }, (res) => {
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
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  const parsedUrl = url.parse(req.url, true);

  if (parsedUrl.pathname === '/' || parsedUrl.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ status: 'ok', service: 'nullmusic core v2' }));
  }

  // Поиск треков (только полные версии, без 30 сек)
  if (parsedUrl.pathname === '/api/search') {
    const query = parsedUrl.query.q;
    if (!query) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Query required' }));
    }

    let foundTracks = [];

    for (const host of INVIDIOUS_HOSTS) {
      try {
        const apiUrl = `https://${host}/api/v1/search?q=${encodeURIComponent(query + ' audio')}&type=video`;
        const data = await fetchJson(apiUrl, 4500);

        if (Array.isArray(data) && data.length > 0) {
          foundTracks = data
            // Фильтруем слишком короткие клипы (меньше 45 сек) и длинные миксы (больше 15 минут)
            .filter(v => v.lengthSeconds && v.lengthSeconds >= 45 && v.lengthSeconds <= 900)
            .map(v => {
              const min = Math.floor(v.lengthSeconds / 60);
              const sec = v.lengthSeconds % 60;
              const thumb = (v.videoThumbnails && v.videoThumbnails.length > 0)
                ? v.videoThumbnails[v.videoThumbnails.length - 1].url
                : `https://images.weserv.nl/?url=i.ytimg.com/vi/${v.videoId}/hqdefault.jpg`;

              return {
                id: v.videoId,
                title: v.title.replace(/\(.*?\)|\[.*?\]/g, '').trim(),
                artist: v.author ? v.author.replace(' - Topic', '').trim() : 'Артист',
                duration: `${min}:${sec < 10 ? '0' : ''}${sec}`,
                rawDuration: v.lengthSeconds,
                cover: thumb,
                streamUrl: `/api/stream/${v.videoId}`
              };
            });

          if (foundTracks.length > 0) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ tracks: foundTracks }));
          }
        }
      } catch (err) {
        // Перебор следующего зеркала
      }
    }

    // Если все хосты недоступны
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ tracks: [] }));
  }

  // Стриминг полного аудиопотока
  if (parsedUrl.pathname.startsWith('/api/stream/')) {
    const videoId = parsedUrl.pathname.replace('/api/stream/', '');

    for (const host of INVIDIOUS_HOSTS) {
      try {
        const streamTarget = `https://${host}/latest_version?id=${videoId}&itag=140`;
        const proxyReq = https.get(streamTarget, {
          headers: { 'User-Agent': 'Mozilla/5.0' }
        }, (streamRes) => {
          if (streamRes.statusCode >= 200 && streamRes.statusCode < 400) {
            res.writeHead(200, {
              'Content-Type': 'audio/mp4',
              'Accept-Ranges': 'bytes',
              'Cache-Control': 'public, max-age=3600'
            });
            streamRes.pipe(res);
          }
        });

        proxyReq.on('error', () => {});
        return;
      } catch (e) {}
    }

    res.writeHead(502, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Stream temporarily unavailable' }));
  }

  res.writeHead(404);
  res.end();
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`nullmusic server running on port ${PORT}`);
});
