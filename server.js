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

function formatDuration(sec) {
  if (!sec || isNaN(sec)) return '—';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s < 10 ? '0' : ''}${s}`;
}

// Поиск полного MP3 в открытом архиве Internet Archive по идентификатору элемента
async function resolveArchiveMp3(identifier) {
  try {
    const meta = await fetchJson(`https://archive.org/metadata/${encodeURIComponent(identifier)}`, 4500);
    if (meta && Array.isArray(meta.files)) {
      const mp3File = meta.files.find(f =>
        f.name && f.name.toLowerCase().endsWith('.mp3') && (!f.Length || parseFloat(f.Length) > 45)
      );
      if (mp3File) {
        return {
          url: `https://archive.org/download/${encodeURIComponent(identifier)}/${encodeURIComponent(mp3File.name)}`,
          duration: mp3File.length ? Math.round(parseFloat(mp3File.length)) : null
        };
      }
    }
  } catch (e) {}
  return null;
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

  // Эндпоинт для резолва полного аудиопотока по названию и артисту
  if (parsedUrl.pathname === '/api/resolve-stream') {
    const q = (parsedUrl.query.q || '').trim();
    if (!q) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ streamUrl: '' }));
    }

    // 1. Проверяем открытые узлы Audius
    const audiusHosts = [
      'https://discoveryprovider.audius.co',
      'https://discoveryprovider2.audius.co',
      'https://discoveryprovider3.audius.co'
    ];
    for (const host of audiusHosts) {
      try {
        const aData = await fetchJson(`${host}/v1/tracks/search?query=${encodeURIComponent(q)}&app_name=nullmusic`, 3500);
        if (aData && Array.isArray(aData.data) && aData.data.length > 0) {
          const best = aData.data.find(t => (t.duration || 0) > 45) || aData.data[0];
          if (best && best.id) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({
              streamUrl: `${host}/v1/tracks/${best.id}/stream?app_name=nullmusic`,
              duration: best.duration || 180
            }));
          }
        }
      } catch (e) {}
    }

    // 2. Проверяем открытый аудио-каталог Internet Archive
    try {
      const iaSearchUrl = `https://archive.org/advancedsearch.php?q=${encodeURIComponent(q + ' AND mediatype:(audio)')}&fl[]=identifier,title,creator&rows=5&page=1&output=json`;
      const iaData = await fetchJson(iaSearchUrl, 4500);
      const docs = iaData?.response?.docs || [];
      for (const doc of docs) {
        const resolved = await resolveArchiveMp3(doc.identifier);
        if (resolved && resolved.url) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({
            streamUrl: resolved.url,
            duration: resolved.duration
          }));
        }
      }
    } catch (e) {}

    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ streamUrl: '' }));
  }

  // Гибридный поиск: Метаданные из iTunes + полные потоки из Audius и Internet Archive
  if (parsedUrl.pathname === '/api/search') {
    const query = parsedUrl.query.q;
    if (!query || !query.trim()) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ tracks: [], error: 'Query is required' }));
    }

    const cleanQuery = query.trim();

    const audiusHosts = [
      'https://discoveryprovider.audius.co',
      'https://discoveryprovider2.audius.co',
      'https://discoveryprovider3.audius.co'
    ];

    const audiusPromise = (async () => {
      for (const host of audiusHosts) {
        try {
          const aData = await fetchJson(`${host}/v1/tracks/search?query=${encodeURIComponent(cleanQuery)}&app_name=nullmusic`, 4000);
          if (aData && Array.isArray(aData.data) && aData.data.length > 0) {
            return aData.data.map(item => ({
              id: `aud_${item.id}`,
              title: item.title || 'Без названия',
              artist: (item.user && item.user.name) ? item.user.name : 'Исполнитель',
              duration: formatDuration(item.duration || 180),
              rawDuration: item.duration || 180,
              cover: (item.artwork && (item.artwork['480x480'] || item.artwork['150x150'])) || '',
              streamUrl: `${host}/v1/tracks/${item.id}/stream?app_name=nullmusic`,
              backupUrl: '',
              isFullStream: true
            }));
          }
        } catch (e) {}
      }
      return [];
    })();

    const itunesPromise = (async () => {
      try {
        const catUrl = `https://itunes.apple.com/search?term=${encodeURIComponent(cleanQuery)}&country=RU&media=music&entity=song&limit=25`;
        const catData = await fetchJson(catUrl, 4500);
        if (catData && Array.isArray(catData.results)) {
          return catData.results;
        }
      } catch (e) {}
      return [];
    })();

    const [audiusStreams, itunesResults] = await Promise.all([audiusPromise, itunesPromise]);

    const tracks = itunesResults.map((item, idx) => {
      const durSec = item.trackTimeMillis ? Math.round(item.trackTimeMillis / 1000) : 180;
      const hiResCover = item.artworkUrl100 ? item.artworkUrl100.replace('100x100bb', '600x600bb') : '';
      const tTitle = item.trackName || 'Без названия';
      const tArtist = item.artistName || 'Исполнитель';

      // Ищем подходящий полный поток по названию или артисту
      const matchedFull = audiusStreams.find(a =>
        a.title.toLowerCase().includes(tTitle.toLowerCase()) ||
        tTitle.toLowerCase().includes(a.title.toLowerCase())
      );

      return {
        id: String(item.trackId || idx),
        title: tTitle,
        artist: tArtist,
        duration: formatDuration(durSec),
        rawDuration: durSec,
        cover: hiResCover,
        streamUrl: matchedFull ? matchedFull.streamUrl : '',
        backupUrl: item.previewUrl || '',
        needsStreamResolve: !matchedFull
      };
    });

    // Добавляем полные треки из Audius, которых не было в списке
    for (const aTrack of audiusStreams) {
      const exists = tracks.some(t =>
        t.title.toLowerCase() === aTrack.title.toLowerCase() &&
        t.artist.toLowerCase() === aTrack.artist.toLowerCase()
      );
      if (!exists) {
        tracks.push(aTrack);
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
