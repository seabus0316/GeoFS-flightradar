// server.js (優化版本)
require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const mongoose = require('mongoose');
const multer = require('multer');
const fs = require('fs');
const mime = require('mime-types');
const FormData = require('form-data');
const fetch = require('node-fetch');
const compression = require('compression'); // 新增

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true });

const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/geofs_flightradar';
const IMGBB_API_KEY = process.env.IMGBB_API_KEY || '';
const ADMIN_PASSWORD = process.env.ADMIN_PASS || 'mysecret';

// ============ 新增:啟用壓縮 ============
app.use(compression());

// MongoDB 連接
mongoose.connect(MONGODB_URI)
  .then(() => console.log('MongoDB connected'))
  .catch(err => console.error('MongoDB connection error:', err));

// Schemas
const photoSchema = new mongoose.Schema({
  file: String,
  thumb: String,
  photographer: String,
  caption: String,
  tags: [String],
  lat: Number,
  lon: Number,
  status: { type: String, default: 'pending' },
  createdAt: { type: Date, default: Date.now }
}, { versionKey: false });

const Photo = mongoose.model('Photo', photoSchema);

const flightPointSchema = new mongoose.Schema({
  aircraftId: { type: String, index: true },
  callsign: String,
  type: String,
  lat: Number,
  lon: Number,
  alt: Number,
  speed: Number,
  heading: Number,
  ts: { type: Number, index: true }
}, { versionKey: false });

const FlightPoint = mongoose.model('FlightPoint', flightPointSchema);

// Express 設定
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Routes (保持不變)
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'atc.html')));
app.get('/admin.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/upload.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'upload.html')));
app.get('/gallery.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'gallery.html')));
app.get('/photomap.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'photomap.html')));
app.get('/health', (req, res) => res.send('ok'));

// Admin middleware
function checkAdminPass(req, res, next) {
  const pass = req.headers['x-admin-pass'];
  if (pass === ADMIN_PASSWORD) {
    next();
  } else {
    res.status(401).json({ error: 'Unauthorized' });
  }
}

// Admin routes (保持不變,已有壓縮)
app.get('/admin/photos/pending', checkAdminPass, async (req, res) => {
  try {
    const photos = await Photo.find({ status: 'pending' }).sort({ createdAt: -1 });
    res.json(photos);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'server error' });
  }
});

app.post('/admin/photos/:id/approve', checkAdminPass, async (req, res) => {
  try {
    const photo = await Photo.findById(req.params.id);
    if (!photo) return res.status(404).json({ error: 'not found' });
    photo.status = 'approved';
    await photo.save();
    res.json({ message: 'approved' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'server error' });
  }
});

app.post('/admin/photos/:id/reject', checkAdminPass, async (req, res) => {
  try {
    const photo = await Photo.findById(req.params.id);
    if (!photo) return res.status(404).json({ error: 'not found' });
    photo.status = 'rejected';
    await photo.save();
    res.json({ message: 'rejected' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'server error' });
  }
});

app.delete('/admin/photos/:id', checkAdminPass, async (req, res) => {
  try {
    await Photo.findByIdAndDelete(req.params.id);
    res.json({ message: 'deleted' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'server error' });
  }
});

app.get('/api/photos', async (req, res) => {
  try {
    const photos = await Photo.find({ status: 'approved' }).sort({ createdAt: -1 });
    res.json(photos);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'server error' });
  }
});

app.delete('/clear/:aircraftId', async (req, res) => {
  try {
    const { aircraftId } = req.params;
    await FlightPoint.deleteMany({ aircraftId });
    broadcastToATC({ type: 'aircraft_track_clear', payload: { aircraftId } });
    res.sendStatus(200);
  } catch (err) {
    console.error('clear error', err);
    res.status(500).json({ error: 'server' });
  }
});

// Upload (保持不變)
const UPLOAD_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR);

const storage = multer.diskStorage({
  destination: UPLOAD_DIR,
  filename: (req, file, cb) => {
    const ext = mime.extension(file.mimetype) || 'jpg';
    const name = Date.now() + '-' + Math.random().toString(36).slice(2, 9) + '.' + ext;
    cb(null, name);
  }
});
const upload = multer({ storage, limits: { fileSize: 30 * 1024 * 1024 } });

app.post('/api/upload', upload.single('photo'), async (req, res) => {
  try {
    const file = req.file;
    if (!file) return res.status(400).json({ error: 'no file' });

    if (!IMGBB_API_KEY) {
      return res.status(500).json({ error: 'ImgBB API key not configured' });
    }

    const imageBuffer = fs.readFileSync(file.path);
    const base64Image = imageBuffer.toString('base64');

    const formData = new FormData();
    formData.append('image', base64Image);

    const imgbbResponse = await fetch(`https://api.imgbb.com/1/upload?key=${IMGBB_API_KEY}`, {
      method: 'POST',
      body: formData
    });

    const imgbbData = await imgbbResponse.json();

    if (!imgbbData.success) {
      throw new Error('ImgBB upload failed: ' + (imgbbData.error?.message || 'unknown error'));
    }

    fs.unlinkSync(file.path);

    const { photographer = 'anon', caption = '', tags = '', lat, lon } = req.body;
    const photo = await Photo.create({
      file: imgbbData.data.url,
      thumb: imgbbData.data.url,
      photographer,
      caption,
      tags: tags.split(',').map(s => s.trim()).filter(Boolean),
      lat: lat ? Number(lat) : null,
      lon: lon ? Number(lon) : null,
      status: 'pending'
    });

    res.json({ ok: true, photo });
  } catch (err) {
    console.error('Upload error:', err);
    res.status(500).json({ error: err.message || 'server error' });
  }
});

// ============ WebSocket 優化 ============
server.on('upgrade', (request, socket, head) => {
  // 檢查路徑是否為 /ws
  const pathname = new URL(request.url, 'http://localhost').pathname;
  
  if (pathname === '/ws' || pathname === '/') {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  } else {
    socket.destroy();
  }
});

const clients = new Set();
const atcClients = new Set();
const playerClients = new Set();
const aircrafts = new Map();

const RETENTION_MS = 12 * 60 * 60 * 1000;

// ============ 新增:批次廣播優化 ============
let broadcastQueue = [];
let broadcastTimer = null;

function queueBroadcast(obj) {
  broadcastQueue.push(obj);
  
  if (!broadcastTimer) {
    broadcastTimer = setTimeout(() => {
      if (broadcastQueue.length > 0) {
        // 合併多個更新為一個訊息
        const updates = broadcastQueue.filter(m => m.type === 'aircraft_update');
        const others = broadcastQueue.filter(m => m.type !== 'aircraft_update');
        
        if (updates.length > 0) {
          const batchUpdate = {
            type: 'aircraft_batch_update',
            payload: updates.map(u => u.payload)
          };
          sendToATC(batchUpdate);
        }
        
        others.forEach(m => sendToATC(m));
        
        broadcastQueue = [];
      }
      broadcastTimer = null;
    }, 100); // 100ms 批次間隔
  }
}

function sendToATC(obj) {
  const msg = JSON.stringify(obj);
  for (const ws of atcClients) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(msg);
    }
  }
}

function broadcastToATC(obj) {
  // 直接發送(用於非頻繁更新)
  sendToATC(obj);
}

// ============ 新增:資料抽稀函數 ============
function simplifyTrack(track, maxPoints = 1000) {
  if (track.length <= maxPoints) return track;
  
  const step = Math.ceil(track.length / maxPoints);
  const simplified = [];
  
  for (let i = 0; i < track.length; i += step) {
    simplified.push(track[i]);
  }
  
  // 確保保留最後一點
  if (simplified[simplified.length - 1] !== track[track.length - 1]) {
    simplified.push(track[track.length - 1]);
  }
  
  return simplified;
}

async function saveFlightPoint(pt) {
  try {
    await FlightPoint.create(pt);
    const cutoff = Date.now() - RETENTION_MS;
    await FlightPoint.deleteMany({ aircraftId: pt.aircraftId, ts: { $lt: cutoff } });
  } catch (err) {
    console.error('saveFlightPoint error', err);
  }
}

async function loadHistoryForAircraft(aircraftId, limit = 1000) { // 從 2000 降到 1000
  try {
    const docs = await FlightPoint.find({ aircraftId })
      .sort({ ts: 1 })
      .limit(limit)
      .lean();
    
    const fullTrack = docs.map(d => ({
      lat: d.lat, lon: d.lon, alt: d.alt, speed: d.speed, ts: d.ts
    }));
    
    // 抽稀後再傳送
    return simplifyTrack(fullTrack, 500);
  } catch (err) {
    console.error('loadHistoryForAircraft error', err);
    return [];
  }
}

wss.on('connection', (ws, req) => {
  clients.add(ws);
  ws.role = 'unknown';
  console.log('WS connected. total clients:', clients.size);

  ws.on('message', async (data) => {
    try {
      const msg = JSON.parse(data);

      if (msg.type === 'hello') {
        ws.role = msg.role || 'unknown';

        if (ws.role === 'atc') {
          atcClients.add(ws);

          const payload = Array.from(aircrafts.values()).map(x => x.payload);
          ws.send(JSON.stringify({ type: 'aircraft_snapshot', payload }));

          for (const [aircraftId] of aircrafts) {
            const tracks = await loadHistoryForAircraft(aircraftId, 1000);
            if (tracks && tracks.length > 0) {
              ws.send(JSON.stringify({
                type: 'aircraft_track_history',
                payload: { aircraftId, tracks }
              }));
            }
          }
        } else if (ws.role === 'player') {
          playerClients.add(ws);
          ws.aircraftId = null;
        }
        return;
      }

      if (msg.type === 'position_update' && msg.payload) {
        const p = msg.payload;
        const id = p.id || (p.callsign ? p.callsign + ':' + (p.playerId || 'p') : null);
        if (!id) return;

        if (ws.role === 'player') {
          ws.aircraftId = id;
        }

        const payload = {
          id,
          callsign: p.callsign || 'UNK',
          type: p.type || '',
          lat: +p.lat || 0,
          lon: +p.lon || 0,
          alt: +p.alt || 0,
          heading: (typeof p.heading !== 'undefined') ? +p.heading : 0,
          speed: (typeof p.speed !== 'undefined') ? +p.speed : 0,
          flightNo: p.flightNo || '',
          departure: p.departure || '',
          arrival: p.arrival || '',
          takeoffTime: p.takeoffTime || '',
          squawk: p.squawk || '',
          ts: Date.now(),
          flightPlan: p.flightPlan || []
        };

        aircrafts.set(id, { payload, lastSeen: Date.now() });

        saveFlightPoint({
          aircraftId: id,
          callsign: payload.callsign,
          type: payload.type,
          lat: payload.lat,
          lon: payload.lon,
          alt: payload.alt,
          speed: payload.speed,
          heading: payload.heading,
          ts: payload.ts
        });

        // ============ 使用批次廣播 ============
        queueBroadcast({
          type: 'aircraft_update',
          payload,
          trackPoint: {
            lat: payload.lat,
            lon: payload.lon,
            alt: payload.alt,
            timestamp: payload.ts
          }
        });

        return;
      }

      if (msg.type === 'clear_track' && msg.aircraftId) {
        await FlightPoint.deleteMany({ aircraftId: msg.aircraftId });
        broadcastToATC({ type: 'aircraft_track_clear', payload: { aircraftId: msg.aircraftId } });
        return;
      }

      if (msg.type === 'disconnect' && msg.aircraftId) {
        await FlightPoint.deleteMany({ aircraftId: msg.aircraftId });
        broadcastToATC({ type: 'aircraft_track_clear', payload: { aircraftId: msg.aircraftId } });
        return;
      }

    } catch (e) {
      console.warn('Bad message', e);
    }
  });

  ws.on('close', async () => {
    clients.delete(ws);
    atcClients.delete(ws);
    playerClients.delete(ws);

    if (ws.role === 'player' && ws.aircraftId) {
      try {
        await FlightPoint.deleteMany({ aircraftId: ws.aircraftId });
      } catch (err) {
        console.error('Error deleting on close', err);
      }
      broadcastToATC({
        type: 'aircraft_track_clear',
        payload: { aircraftId: ws.aircraftId }
      });
    }

    console.log('WS closed. total clients:', clients.size);
  });

  ws.on('error', (e) => {
    console.warn('WS error', e);
  });
});

// 清理逾時飛機
setInterval(async () => {
  const now = Date.now();
  const timeout = 30000;
  let removed = [];
  for (const [id, v] of aircrafts.entries()) {
    if (now - v.lastSeen > timeout) {
      aircrafts.delete(id);
      removed.push(id);
      try {
        await FlightPoint.deleteMany({ aircraftId: id });
      } catch (err) {
        console.error('cleanup delete error', err);
      }
    }
  }
  if (removed.length) {
    broadcastToATC({ type: 'aircraft_remove', payload: removed });
    removed.forEach(aircraftId => {
      broadcastToATC({
        type: 'aircraft_track_clear',
        payload: { aircraftId }
      });
    });
  }
}, 5000);

// 定期清理舊資料
setInterval(async () => {
  try {
    const cutoff = Date.now() - RETENTION_MS;
    await FlightPoint.deleteMany({ ts: { $lt: cutoff } });
  } catch (err) {
    console.error('Prune error', err);
  }
}, 6 * 60 * 60 * 1000);

server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
