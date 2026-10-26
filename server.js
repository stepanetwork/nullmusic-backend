const http = require('http');
const https = require('https');
const url = require('url');

const PORT = process.env.PORT || 10000;

function fetchText(targetUrl, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const req = https.get(targetUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'ru,en;q=0.9'
      }
    }, (res) => {
      // Поддержка редиректов
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return resolve(fetchText(res.headers.location, timeoutMs));
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => {
      req.abort();
      reject(new Error('Timeout'));
    });
  });
}

function fetchJson(targetUrl, timeoutMs = 6000) {
  return fetchText(targetUrl, timeoutMs).then(text => JSON.parse(text));
}

const server = http.createServer(async (req, res) => {
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
    return res.end(JSON.stringify({ status: 'ok', uptime: process.uptime() }));
  }

  // 1. Полноценный поиск (SoundCloud Hydration + Invidious)
  if (parsedUrl.pathname === '/api/search') {
    const query = parsedUrl.query.q;
    if (!query) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Query required' }));
    }

    let tracks = [];

    // Метод А: SoundCloud SSR Hydration (полные версии Кишлака, АПФС, без ограничений)
    try {
      const scSearchUrl = `https://soundcloud.com/search/sounds?q=${encodeURIComponent(query)}`;
      const html = await fetchText(scSearchUrl, 6000);
      const match = html.match(/window\.__sc_hydration\s*=\s*(\[.*?\]);\s*<\/script>/);

      if (match && match[1]) {
        const hydration = JSON.parse(match[1]);
        const soundItems = hydration.filter(item => item.hydratable === 'sound' || item.data?.kind === 'track');

        soundItems.forEach(item => {
          const t = item.data;
          if (!t || !t.title) return;

          const durSec = Math.round((t.duration || 180000) / 1000);
          if (durSec < 40 || durSec > 1200) return; // фильтр мусора

          const min = Math.floor(durSec / 60);
          const sec = durSec % 60;

          let art = t.artwork_url || t.user?.avatar_url || '';
          if (art) art = art.replace('-large', '-t500x500');

          tracks.push({
            id: 'sc_' + t.id,
            title: t.title,
            artist: t.user?.username || 'Исполнитель',
            duration: `${min}:${sec < 10 ? '0' : ''}${sec}`,
            rawDuration: durSec,
            cover: art ? `https://images.weserv.nl/?url=${encodeURIComponent(art.replace(/^https?:\/\//, ''))}` : '',
            // Потоковый плеер SoundCloud
            streamUrl: t.permalink_url ? `https://w.soundcloud.com/player/?url=${encodeURIComponent(t.permalink_url)}&auto_play=true` : '',
            rawUrl: t.permalink_url || ''
          });
        });
      }
    } catch (e) {
      console.warn('SoundCloud scrape err:', e.message);
    }

    // Метод Б: Invidious / Piped резервный шлюз
    if (tracks.length === 0) {
      const mirrors = ['https://pipedapi.kavin.rocks', 'https://api.piped.privacy.com.de', 'https://inv.nadeko.net'];
      for (const host of mirrors) {
        try {
          const searchData = await fetchJson(`${host}/api/v1/search?q=${encodeURIComponent(query + ' audio')}&filter=music_songs`, 4000);
          const items = searchData.items || searchData;
          if (Array.isArray(items) && items.length > 0) {
            tracks = items.slice(0, 15).map(v => {
              const sec = v.duration || 180;
              return {
                id: v.url ? v.url.replace('/watch?v=', '') : ('yt_' + Math.random()),
                title: v.title || query,
                artist: v.uploaderName || 'Артист',
                duration: `${Math.floor(sec/60)}:${sec%60 < 10 ? '0':''}${sec%60}`,
                rawDuration: sec,
                cover: v.thumbnail ? `https://images.weserv.nl/?url=${encodeURIComponent(v.thumbnail.replace(/^https?:\/\//, ''))}` : '',
                streamUrl: `/api/stream/${v.url ? v.url.replace('/watch?v=', '') : ''}`
              };
            });
            break;
          }
        } catch (err) {}
      }
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ tracks }));
  }

  res.writeHead(404);
  res.end();
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});
