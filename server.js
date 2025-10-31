// server.js (MongoDB-integrated)
// replace your existing server.js with this file
require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const mongoose = require('mongoose');
// --- JetPhotos upload/review system ---
const multer = require('multer');
const fs = require('fs');
const mime = require('mime-types');
const sharp = require('sharp');
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true });

const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/geofs_flightradar';

// ------------ MongoDB ------------
mongoose.connect(MONGODB_URI)
// === JetPhotos photo schema ===
const photoSchema = new mongoose.Schema({
  file: String,
  thumb: String,
  photographer: String,
  caption: String,
  tags: [String],
  lat: Number,
  lon: Number,
  status: { type: String, default: 'pending' }, // pending / approved / rejected
  createdAt: { type: Date, default: Date.now }
}, { versionKey: false });

const Photo = mongoose.model('Photo', photoSchema);

const flightPointSchema = new mongoose.Schema({
  aircraftId: { type: String, index: true }, // e.g. callsign or id
  callsign: String,
  type: String,
  lat: Number,
  lon: Number,
  alt: Number,
  speed: Number,
  heading: Number,
  ts: { type: Number, index: true } // timestamp in ms
}, { versionKey: false });

const FlightPoint = mongoose.model('FlightPoint', flightPointSchema);

// ------------ app routes ------------
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'atc.html'));
});

app.get('/health', (req, res) => res.send('ok'));

// API: manual clear (optional for admin / ATC)
app.delete('/clear/:aircraftId', async (req, res) => {
  try {
    const { aircraftId } = req.params;
    await FlightPoint.deleteMany({ aircraftId });
    // broadcast clear to ATC
    broadcastToATC({ type: 'aircraft_track_clear', payload: { aircraftId } });
    res.sendStatus(200);
  } catch (err) {
    console.error('clear error', err);
    res.status(500).json({ error: 'server' });
  }
});
// === JetPhotos upload system ===
const UPLOAD_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR);
app.use('/uploads', express.static(UPLOAD_DIR));

// multer setup
const storage = multer.diskStorage({
  destination: UPLOAD_DIR,
  filename: (req, file, cb) => {
    const ext = mime.extension(file.mimetype) || 'jpg';
    const name = Date.now() + '-' + Math.random().toString(36).slice(2, 9) + '.' + ext;
    cb(null, name);
  }
});
const upload = multer({ storage, limits: { fileSize: 30 * 1024 * 1024 } });

// === 上傳照片 ===
app.post('/api/upload', upload.single('photo'), async (req, res) => {
  try {
    const file = req.file;
    if (!file) return res.status(400).json({ error: 'no file' });

    const thumbPath = path.join(UPLOAD_DIR, 'thumb-' + file.filename);
    await sharp(file.path).resize({ width: 1000, withoutEnlargement: true }).toFile(thumbPath);

    const { photographer = 'anon', caption = '', tags = '', lat, lon } = req.body;
    const photo = await Photo.create({
      file: '/uploads/' + file.filename,
      thumb: '/uploads/' + path.basename(thumbPath),
      photographer,
      caption,
      tags: tags.split(',').map(s => s.trim()).filter(Boolean),
      lat: lat ? Number(lat) : null,
      lon: lon ? Number(lon) : null,
      status: 'pending'
    });

    res.json({ ok: true, photo });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'server error' });
  }
});
// === JetPhotos admin review system ===
const ADMIN_PASSWORD = process.env.ADMIN_PASS || 'mysecret';

// 密碼驗證中介層
app.use('/admin', (req, res, next) => {
  const pass = req.headers['x-admin-pass'];
  if (pass !== ADMIN_PASSWORD) return res.status(403).json({ error: 'forbidden' });
  next();
});

// 查詢待審核照片
app.get('/admin/photos/pending', async (req, res) => {
  const pending = await Photo.find({ status: 'pending' }).sort({ createdAt: -1 });
  res.json(pending);
});

// 核准照片
app.post('/admin/photos/:id/approve', async (req, res) => {
  const photo = await Photo.findById(req.params.id);
  if (!photo) return res.status(404).json({ error: 'not found' });
  photo.status = 'approved';
  await photo.save();
  res.json({ message: 'approved' });
});

// 拒絕照片
app.post('/admin/photos/:id/reject', async (req, res) => {
  const photo = await Photo.findById(req.params.id);
  if (!photo) return res.status(404).json({ error: 'not found' });
  photo.status = 'rejected';
  await photo.save();
  res.json({ message: 'rejected' });
});

// 公開 API：僅顯示已核准的照片
app.get('/api/photos', async (req, res) => {
  const photos = await Photo.find({ status: 'approved' }).sort({ createdAt: -1 });
  res.json(photos);
});

// -------------- WebSocket upgrade --------------
server.on('upgrade', (request, socket, head) => {
  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit('connection', ws, request);
  });
});

// clients bookkeeping (same as original)
const clients = new Set(); // all ws clients
const atcClients = new Set();
const playerClients = new Set();

// track aircraft state keyed by aircraft id (in-memory snapshot for quick broadcast)
const aircrafts = new Map();

// retention policy (ms)
const RETENTION_MS = 12 * 60 * 60 * 1000; // 12 hours (same as original logic)

// Helper: broadcast to ATC clients
function broadcastToATC(obj) {
  const msg = JSON.stringify(obj);
  for (const ws of atcClients) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(msg);
    }
  }
}

// Save flight point to MongoDB and prune old points for that aircraft
async function saveFlightPoint(pt) {
  try {
    await FlightPoint.create(pt);
    const cutoff = Date.now() - RETENTION_MS;
    // optional prune: remove points older than retention for this aircraft
    await FlightPoint.deleteMany({ aircraftId: pt.aircraftId, ts: { $lt: cutoff } });
  } catch (err) {
    console.error('saveFlightPoint error', err);
  }
}

// Query history for a given aircraftId (sorted)
async function loadHistoryForAircraft(aircraftId, limit = 2000) {
  try {
    const docs = await FlightPoint.find({ aircraftId }).sort({ ts: 1 }).limit(limit).lean();
    return docs.map(d => ({
      lat: d.lat, lon: d.lon, alt: d.alt, speed: d.speed, ts: d.ts
    }));
  } catch (err) {
    console.error('loadHistoryForAircraft error', err);
    return [];
  }
}

// On incoming websocket connection
wss.on('connection', (ws, req) => {
  clients.add(ws);
  ws.role = 'unknown';
  console.log('WS connected. total clients:', clients.size);

  ws.on('message', async (data) => {
    try {
      const msg = JSON.parse(data);

      // hello message - register role
      if (msg.type === 'hello') {
        ws.role = msg.role || 'unknown';

        if (ws.role === 'atc') {
          atcClients.add(ws);

          // 發送當前飛機 snapshot (in-memory)
          const payload = Array.from(aircrafts.values()).map(x => x.payload);
          ws.send(JSON.stringify({ type: 'aircraft_snapshot', payload }));

          // 對每個在 snapshot 的 aircraft，從 DB 拉出歷史並發給這個 ATC client
          // 若 aircrafts map 很大，這段可改成只拉特定 aircraftId 或做 rate-limit
          for (const [aircraftId] of aircrafts) {
            const tracks = await loadHistoryForAircraft(aircraftId, 5000);
            if (tracks && tracks.length > 0) {
              ws.send(JSON.stringify({
                type: 'aircraft_track_history',
                payload: { aircraftId, tracks }
              }));
            }
          }

          // 此外，也可以列出最近在 DB 但不在 snapshot 的 aircrafts（選擇性）
          // (跳過以免一次發太多)
        } else if (ws.role === 'player') {
          playerClients.add(ws);
          ws.aircraftId = null; // set on first position update
        }
        return;
      }

      // position update from client player
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

        // update in-memory snapshot for quick broadcast & snapshot API
        aircrafts.set(id, { payload, lastSeen: Date.now() });

        // store to MongoDB (non-blocking)
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

        // broadcast update to ATC clients (same shape as original)
        broadcastToATC({
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

      // client asked to clear its track (optional custom message type)
      if (msg.type === 'clear_track' && msg.aircraftId) {
        await FlightPoint.deleteMany({ aircraftId: msg.aircraftId });
        broadcastToATC({ type: 'aircraft_track_clear', payload: { aircraftId: msg.aircraftId } });
        return;
      }

      // client disconnect asked explicitly
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

    // player disconnected -> clear its track from DB and notify ATC (same behaviour as original)
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

// cleanup stale aircrafts periodically (same as original)
setInterval(async () => {
  const now = Date.now();
  const timeout = 30000; // 30s
  let removed = [];
  for (const [id, v] of aircrafts.entries()) {
    if (now - v.lastSeen > timeout) {
      aircrafts.delete(id);
      removed.push(id);
      // also clear DB history for that aircraft (same as original behaviour)
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

// periodic prune: delete anything older than retention (safety)
setInterval(async () => {
  try {
    const cutoff = Date.now() - RETENTION_MS;
    await FlightPoint.deleteMany({ ts: { $lt: cutoff } });
    // console.log('Pruned old flight points before', new Date(cutoff).toISOString());
  } catch (err) {
    console.error('Prune error', err);
  }
}, 6 * 60 * 60 * 1000); // every 6h

server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
