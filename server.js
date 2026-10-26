const express = require('express');
const cors = require('cors');
const ytsr = require('ytsr');
const play = require('play-dl');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Пинг для проверки работоспособности
app.get('/', (req, res) => {
  res.send('nullmusic API is online');
});

// 1. Поиск полных оригинальных треков и обложек
app.get('/api/search', async (req, res) => {
  try {
    const q = req.query.q;
    if (!q) return res.status(400).json({ error: 'Query required' });

    // Ищем музыкальные треки без цензуры
    const searchResults = await ytsr(q, { limit: 25 });
    const items = searchResults.items.filter(i => i.type === 'video');

    const tracks = items.map(item => {
      // Парсим длительность из формата mm:ss в секунды
      let rawSec = 180;
      if (item.duration) {
        const parts = item.duration.split(':').map(Number);
        if (parts.length === 2) rawSec = parts[0] * 60 + parts[1];
        if (parts.length === 3) rawSec = parts[0] * 3600 + parts[1] * 60 + parts[2];
      }

      // Достаем оригинальную обложку
      const thumb = (item.thumbnails && item.thumbnails.length > 0)
        ? item.thumbnails[item.thumbnails.length - 1].url
        : (item.bestThumbnail ? item.bestThumbnail.url : '');

      return {
        id: item.id,
        title: item.title,
        artist: item.author ? item.author.name.replace(' - Topic', '') : 'Исполнитель',
        duration: item.duration || '3:00',
        rawDuration: rawSec,
        cover: thumb,
        streamUrl: `/api/stream/${item.id}`
      };
    });

    res.json({ tracks });
  } catch (err) {
    console.error('Search error:', err);
    res.status(500).json({ error: 'Search failed' });
  }
});

// 2. Стриминг полного аудиопотока
app.get('/api/stream/:id', async (req, res) => {
  try {
    const videoId = req.params.id;
    const info = await play.video_info(`https://www.youtube.com/watch?v=${videoId}`);
    const stream = await play.stream_from_info(info);

    res.setHeader('Content-Type', stream.type || 'audio/webm');
    res.setHeader('Accept-Ranges', 'bytes');
    stream.stream.pipe(res);
  } catch (err) {
    console.error('Stream error:', err);
    res.status(500).json({ error: 'Stream failed' });
  }
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
```
