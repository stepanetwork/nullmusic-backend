const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Проверка активности сервера
app.get('/', (req, res) => {
  res.send({ status: 'ok', service: 'nullmusic core api' });
});

// Открытые рабочие зеркала Invidious
const INVIDIOUS_INSTANCES = [
  'https://inv.nadeko.net',
  'https://invidious.private.coffee',
  'https://yewtu.be',
  'https://iv.melmac.space'
];

// Поиск треков
app.get('/api/search', async (req, res) => {
  const query = req.query.q;
  if (!query) return res.status(400).json({ error: 'Query is required' });

  for (const instance of INVIDIOUS_INSTANCES) {
    try {
      const response = await axios.get(`${instance}/api/v1/search`, {
        params: { q: query, type: 'video' },
        timeout: 4500
      });

      if (response.data && Array.isArray(response.data)) {
        const tracks = response.data
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
              artist: v.author ? v.author.replace(' - Topic', '') : 'Исполнитель',
              duration: `${min}:${sec < 10 ? '0' : ''}${sec}`,
              rawDuration: v.lengthSeconds,
              cover: thumb,
              streamUrl: `/api/stream/${v.videoId}`
            };
          });

        return res.json({ tracks });
      }
    } catch (e) {
      // Переход к следующему зеркалу при ошибке
    }
  }

  // Резервный поиск
  try {
    const backupRes = await axios.get(`https://itunes.apple.com/search`, {
      params: { term: query, country: 'RU', media: 'music', limit: 25 },
      timeout: 3000
    });
    const fallbackTracks = (backupRes.data.results || []).map(r => ({
      id: String(r.trackId),
      title: r.trackName,
      artist: r.artistName,
      duration: '3:00',
      rawDuration: 180,
      cover: r.artworkUrl100 ? r.artworkUrl100.replace('100x100bb', '500x500bb') : '',
      streamUrl: r.previewUrl
    }));
    return res.json({ tracks: fallbackTracks });
  } catch (err) {
    res.status(500).json({ error: 'Search failed' });
  }
});

// Стриминг аудиопотока
app.get('/api/stream/:id', async (req, res) => {
  const videoId = req.params.id;

  for (const instance of INVIDIOUS_INSTANCES) {
    try {
      const streamUrl = `${instance}/latest_version?id=${videoId}&itag=140`;
      const response = await axios({
        method: 'get',
        url: streamUrl,
        responseType: 'stream',
        timeout: 6000
      });

      res.setHeader('Content-Type', 'audio/mp4');
      return response.data.pipe(res);
    } catch (e) {
      // Переход к следующему инстансу
    }
  }

  res.status(502).json({ error: 'Audio stream unavailable' });
});

app.listen(PORT, () => {
  console.log(`nullmusic server running on port ${PORT}`);
});
```
