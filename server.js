// server.js (混合版 - Socket.IO + WebSocket)
// ✅ v2 新增：FlightSession 歷史紀錄 + Discord OAuth + 緊急 Squawk 警報
require('dotenv').config();
const express = require('express');
const http = require('http');
const fs = require('fs');
const WebSocket = require('ws');
const path = require('path');
const mongoose = require('mongoose');
const multer = require('multer');
const mime = require('mime-types');
const FormData = require('form-data');
const fetch = require('node-fetch');
const compression = require('compression');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const { Server: IOServer } = require('socket.io');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true });

// ============ 環境變數 ============
const PORT                = process.env.PORT                || 3000;
const MONGODB_URI         = process.env.MONGODB_URI         || 'mongodb://localhost:27017/geofs_flightradar';
const IMGBB_API_KEY       = process.env.IMGBB_API_KEY       || '';
const ADMIN_PASSWORD      = process.env.ADMIN_PASS          || 'mysecret';
const AIRLINE_WEBHOOK_URL = process.env.AIRLINE_WEBHOOK_URL || '';
const FLIGHT_WEBHOOK_URL  = process.env.FLIGHT_WEBHOOK_URL  || ''; // 飛行完成通報
const ALERT_WEBHOOK_URL   = process.env.ALERT_WEBHOOK_URL   || ''; // 緊急 Squawk 警報
// Discord OAuth
const DISCORD_CLIENT_ID     = process.env.DISCORD_CLIENT_ID     || '';
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET || '';
const DISCORD_REDIRECT_URI  = process.env.DISCORD_REDIRECT_URI  || ''; // e.g. https://geofs-flightradar.duckdns.org/auth/discord/callback
const JWT_SECRET            = process.env.JWT_SECRET            || 'change_this_secret';

// ============ 共用變數 ============
const aircrafts    = new Map();
const RETENTION_MS = 12 * 60 * 60 * 1000;

const clients         = new Set();
const atcClients      = new Set();
const playerClients   = new Set();
const ioAtcClients    = new Set();
const ioPlayerClients = new Set();

const alertedSquawks = new Map(); // aircraftId → squawk code（防重複警報）
const waypointState = new Map(); // aircraftId → { planHash, triggered }
 
function normalizeFlightLookup(value) {
  return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function haversineNm(lat1, lon1, lat2, lon2) {
  const R = 3440.065; // Earth radius in nautical miles
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
 
async function checkWaypointReminder(payload) {
  const { id: aircraftId, flightPlan, lat, lon, userId, callsign, arrival } = payload;
 
  // 至少要有 2 個航點，且飛機有綁定用戶
  if (!flightPlan || flightPlan.length < 2 || !userId) return;
 
  const penultimate = flightPlan[flightPlan.length - 2];
  if (!penultimate || typeof penultimate.lat === 'undefined') return;
 
  // planHash：用來偵測換了航線就重置觸發狀態
  const planHash = `${flightPlan.length}_${penultimate.lat?.toFixed(3)}_${penultimate.lon?.toFixed(3)}`;
  let state = waypointState.get(aircraftId) || { planHash: null, triggered: false };
  if (state.planHash !== planHash) state = { planHash, triggered: false };
 
  // 已經觸發過就跳過
  if (state.triggered) { waypointState.set(aircraftId, state); return; }
 
  // 距離倒數第二航點超過 30 nm 就不處理
  const dist = haversineNm(lat, lon, penultimate.lat, penultimate.lon);
  if (dist > 30) { waypointState.set(aircraftId, state); return; }
 
  // 查找用戶與提醒設定
  const user = await User.findOne({ geofsUserId: String(userId) }).lean();
  if (!user?.discordId) { state.triggered = true; waypointState.set(aircraftId, state); return; }
 
  const pref = await ReminderPreference.findOne({ discordId: user.discordId, enabled: true }).lean();
  if (!pref) { state.triggered = true; waypointState.set(aircraftId, state); return; }
 
  // 航點名稱：優先用 name/id，fallback 座標
  const wpLabel = penultimate.name || penultimate.id ||
    `${penultimate.lat?.toFixed(2)}, ${penultimate.lon?.toFixed(2)}`;
 
  await PendingNotification.create({
    discordId:           user.discordId,
    callsign:            callsign || 'N/A',
    arrival:             arrival  || '',
    penultimateWaypoint: wpLabel,
    sent:                false,
  });
 
  state.triggered = true;
  waypointState.set(aircraftId, state);
  console.log(`[Reminder] Queued for ${user.discordId} (${callsign}) approaching ${wpLabel}`);
}
// ============ Middleware ============
app.use(compression());
app.use(cookieParser());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ============ Schemas ============

const photoSchema = new mongoose.Schema({
  file: String, thumb: String, photographer: String, caption: String,
  tags: [String], lat: Number, userId: String, lon: Number,
  status: { type: String, default: 'pending' },
  createdAt: { type: Date, default: Date.now }
}, { versionKey: false });
const Photo = mongoose.model('Photo', photoSchema);

const flightPointSchema = new mongoose.Schema({
  aircraftId: { type: String, index: true },
  callsign: String, type: String,
  lat: Number, lon: Number, alt: Number,
  userId: String, speed: Number, heading: Number,
  ts: { type: Number, index: true }
}, { versionKey: false });
const FlightPoint = mongoose.model('FlightPoint', flightPointSchema);

// ✅ 新增：已完成飛行存檔
const flightSessionSchema = new mongoose.Schema({
  aircraftId:    { type: String, index: true },
  discordId:     { type: String, index: true, sparse: true },
  geofsUserId:   { type: String, sparse: true },
  callsign:      String,
  type:          String,
  departure:     String,
  arrival:       String,
  startTime:     { type: Number, index: true },
  endTime:       Number,
  duration:      Number,    // 秒
  maxAlt:        Number,    // 英尺
  maxSpeed:      Number,    // 節
  distanceNm:    Number,    // 海里
  trackSnapshot: [{ lat: Number, lon: Number, alt: Number, ts: Number }],
  status:        { type: String, default: 'completed' } // 'completed' | 'aborted'
}, { versionKey: false, timestamps: true });
const FlightSession = mongoose.model('FlightSession', flightSessionSchema);

// ✅ 新增：Discord 用戶帳號
const userSchema = new mongoose.Schema({
  discordId:        { type: String, unique: true, index: true },
  username:         String,
  displayName:      String,   // 顯示名稱（Discord global_name 或 username）
  discriminator:    String,
  photos:           [String], // Discord avatar URL 陣列
  geofsUserId:      { type: String, index: true, sparse: true },
  apiKey:           { type: String, index: true, sparse: true },
  // 管理員權限
  isSuperAdmin:     { type: Boolean, default: false },
  managedAirlines:  { type: [String], default: [] }, // e.g. ['EVA', 'CAL']
  accessToken:      String,
  refreshToken:     String,
  linkedAt:         Date,
  createdAt:        { type: Date, default: Date.now }
}, { versionKey: false });
const User = mongoose.model('User', userSchema);

// 產生隨機 API Key
function generateApiKey() {
  return require('crypto').randomBytes(24).toString('hex');
}

// 把 User document 轉成前端期望的格式
function formatUserForClient(user) {
  return {
    authenticated: true,
    user: {
      discordId:   user.discordId,
      displayName: user.displayName || user.username,
      username:    user.username,
      photos:      user.photos || [],
      apiKey:      user.apiKey || null,
      geofsUserId: user.geofsUserId || null
    },
    admin: {
      isSuperAdmin:     user.isSuperAdmin || false,
      managedAirlines:  user.managedAirlines || []
    }
  };
}
const ReminderPreference = mongoose.model('ReminderPreference', new mongoose.Schema({
  discordId: { type: String, unique: true, index: true },
  enabled:   { type: Boolean, default: true },
  updatedAt: { type: Date, default: Date.now },
}, { versionKey: false }));
 
const PendingNotification = mongoose.model('PendingNotification', new mongoose.Schema({
  discordId:           String,
  callsign:            String,
  arrival:             String,
  penultimateWaypoint: String,
  sent:                { type: Boolean, default: false, index: true },
  createdAt:           { type: Date, default: Date.now },
}, { versionKey: false }));
// ============ MongoDB 連線 ============
mongoose.connect(MONGODB_URI)
  .then(async () => {
    console.log('✅ MongoDB connected');
    await FlightPoint.collection.createIndex({ aircraftId: 1, ts: 1 });
    await FlightPoint.collection.createIndex({ ts: 1 });
    await FlightSession.collection.createIndex({ startTime: -1 });
    await FlightSession.collection.createIndex({ discordId: 1 });
    await User.collection.createIndex({ discordId: 1 }, { unique: true });
    await User.collection.createIndex({ geofsUserId: 1 }, { sparse: true });
    console.log('✅ MongoDB indexes created');
  })
  .catch(err => console.error('MongoDB connection error:', err));

// ============ 工具函數 ============

function simplifyTrack(track, maxPoints = 1000) {
  if (track.length <= maxPoints) return track;
  const timeSpan = track[track.length - 1].ts - track[0].ts;
  const targetInterval = timeSpan / maxPoints;
  const simplified = [track[0]];
  let lastTime = track[0].ts;
  for (let i = 1; i < track.length - 1; i++) {
    const point = track[i];
    const timeDiff = point.ts - lastTime;
    const altChange = Math.abs(point.alt - track[i - 1].alt);
    const speedChange = Math.abs(point.speed - track[i - 1].speed);
    if (timeDiff >= targetInterval || altChange > 500 || speedChange > 50) {
      simplified.push(point);
      lastTime = point.ts;
    }
  }
  simplified.push(track[track.length - 1]);
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

async function loadHistoryForAircraft(aircraftId, limit = 10000) {
  try {
    const docs = await FlightPoint.find({ aircraftId }).sort({ ts: 1 }).limit(limit).lean();
    const fullTrack = docs.map(d => ({ lat: d.lat, lon: d.lon, alt: d.alt, speed: d.speed, ts: d.ts }));
    return simplifyTrack(fullTrack, 2000);
  } catch (err) {
    console.error('loadHistoryForAircraft error', err);
    return [];
  }
}

function broadcastToATC(obj) {
  const msg = JSON.stringify(obj);
  for (const ws of atcClients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  }
  ioAtcClients.forEach(socket => socket.emit(obj.type, obj.payload || obj));
}

// Haversine 距離（海里）
function haversineNm(lat1, lon1, lat2, lon2) {
  const R = 3440.065;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ✅ 存檔飛行紀錄（斷線時呼叫）
async function finalizeFlightSession(aircraftId, status = 'completed') {
  try {
    const docs = await FlightPoint.find({ aircraftId }).sort({ ts: 1 }).lean();
    if (docs.length < 5) return; // 太少點，略過

    const aircraft = aircrafts.get(aircraftId);
    const payload  = aircraft?.payload || {};

    // 找對應的 Discord 用戶
    const user = payload.userId
      ? await User.findOne({ geofsUserId: String(payload.userId) }).lean()
      : null;

    // 計算飛行統計
    let distanceNm = 0, maxAlt = 0, maxSpeed = 0;
    for (let i = 1; i < docs.length; i++) {
      distanceNm += haversineNm(docs[i - 1].lat, docs[i - 1].lon, docs[i].lat, docs[i].lon);
      if (docs[i].alt)   maxAlt   = Math.max(maxAlt,   docs[i].alt);
      if (docs[i].speed) maxSpeed = Math.max(maxSpeed, docs[i].speed);
    }
    distanceNm = Math.round(distanceNm);

    const startTime     = docs[0].ts;
    const endTime       = docs[docs.length - 1].ts;
    const duration      = Math.round((endTime - startTime) / 1000);
    const trackSnapshot = simplifyTrack(
      docs.map(d => ({ lat: d.lat, lon: d.lon, alt: d.alt || 0, ts: d.ts })), 500
    );

    const session = await FlightSession.create({
      aircraftId,
      discordId:   user?.discordId  || null,
      geofsUserId: payload.userId   ? String(payload.userId) : null,
      callsign:    payload.callsign || docs[0].callsign || 'UNK',
      flightNo:    payload.flightNo || '',
      type:        payload.type     || docs[0].type     || '',
      departure:   payload.departure || '',
      arrival:     payload.arrival   || '',
      startTime, endTime, duration,
      maxAlt: Math.round(maxAlt), maxSpeed: Math.round(maxSpeed), distanceNm,
      trackSnapshot, status
    });

    console.log(`[FlightSession] ${status} ${session._id} — ${session.callsign}, ${distanceNm} nm, ${Math.floor(duration / 60)}m`);

    // Discord 飛行完成通報（飛行時間 > 2 分鐘才通報）
    if (FLIGHT_WEBHOOK_URL && duration >= 120) {
      const durationStr = `${Math.floor(duration / 3600)}h ${Math.floor((duration % 3600) / 60)}m`;
      const pilot = user
        ? `<@${user.discordId}> (${user.username})`
        : (payload.userId ? `GeoFS #${payload.userId}` : 'Unknown');

      fetch(FLIGHT_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: 'Flight Logger',
          avatar_url: 'https://i.ibb.co/fzm8m0LS/geofs-flightradar.webp',
          embeds: [{
            title: `${status === 'completed' ? '🛬' : '⚠️'} Flight ${status === 'completed' ? 'Completed' : 'Aborted'} — ${session.callsign}`,
            color: status === 'completed' ? 0x00b4d8 : 0x888888,
            fields: [
              { name: '✈ Aircraft',   value: session.type     || 'Unknown', inline: true },
              { name: '📡 Callsign',  value: session.callsign || 'N/A',     inline: true },
              { name: '👤 Pilot',     value: pilot,                          inline: true },
              { name: '🛫 Departure', value: session.departure || 'N/A',    inline: true },
              { name: '🛬 Arrival',   value: session.arrival  || 'N/A',     inline: true },
              { name: '⏱ Duration',  value: durationStr,                   inline: true },
              { name: '📏 Distance',  value: `${distanceNm} nm`,            inline: true },
              { name: '🔝 Max Alt',   value: `${Math.round(maxAlt)} ft`,    inline: true },
              { name: '💨 Max Speed', value: `${Math.round(maxSpeed)} kts`, inline: true }
            ],
            footer: { text: `Flight Logger · ${new Date().toISOString()}` }
          }]
        })
      }).catch(e => console.error('Flight webhook error', e));
    }

    return session;
  } catch (err) {
    console.error('finalizeFlightSession error', err);
  }
}

// ✅ 緊急 Squawk 警報（7700 / 7500 / 7600）
async function sendSquawkAlert(payload) {
  if (!ALERT_WEBHOOK_URL) return;
  if (!['7700', '7500', '7600'].includes(payload.squawk)) {
    // 如果 squawk 恢復正常，重置警報狀態
    if (alertedSquawks.has(payload.id)) alertedSquawks.delete(payload.id);
    return;
  }
  if (alertedSquawks.get(payload.id) === payload.squawk) return; // 已通報

  alertedSquawks.set(payload.id, payload.squawk);

  const info = {
    '7700': { emoji: '🆘', label: 'GENERAL EMERGENCY', color: 0xff0000 },
    '7500': { emoji: '🔫', label: 'HIJACK',            color: 0xff4500 },
    '7600': { emoji: '📻', label: 'RADIO FAILURE',     color: 0xffa500 }
  }[payload.squawk];

  fetch(ALERT_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      content: '@here',
      username: 'ATC Alert',
      avatar_url: 'https://i.ibb.co/fzm8m0LS/geofs-flightradar.webp',
      embeds: [{
        title: `${info.emoji} SQUAWK ${payload.squawk} — ${info.label}`,
        color: info.color,
        fields: [
          { name: 'Callsign', value: payload.callsign || 'N/A',                                  inline: true },
          { name: 'Aircraft', value: payload.type     || 'Unknown',                              inline: true },
          { name: 'Altitude', value: `${Math.round(payload.alt)} ft`,                           inline: true },
          { name: 'Speed',    value: `${Math.round(payload.speed)} kts`,                        inline: true },
          { name: 'Position', value: `${payload.lat.toFixed(4)}, ${payload.lon.toFixed(4)}`,    inline: true }
        ],
        footer: { text: new Date().toISOString() }
      }]
    })
  }).catch(e => console.error('Alert webhook error', e));
}

// ============ JWT Middleware ============
function authMiddleware(req, res, next) {
  const token = req.cookies.auth_token || (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  try {
    req.jwtUser = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
}

function checkAdminPass(req, res, next) {
  if (req.headers['x-admin-pass'] === ADMIN_PASSWORD) next();
  else res.status(401).json({ error: 'Unauthorized' });
}

// ============ Socket.IO ============
const io = new IOServer(server, {
  cors: {
    origin: ['https://www.geo-fs.com', 'https://geo-fs.com'],
    methods: ['GET', 'POST'],
    credentials: true
  },
  pingInterval: 25000,
  pingTimeout: 60000
});

io.on('connection', async (socket) => {
  console.log('Socket.IO client connected:', socket.id);

  // 如果 client 帶了 JWT（query 或 cookie），推送用戶資料
  try {
    const token = socket.handshake.auth?.token
      || socket.handshake.query?.token
      || (socket.handshake.headers?.cookie || '').match(/auth_token=([^;]+)/)?.[1];
    if (token) {
      const decoded = jwt.verify(token, JWT_SECRET);
      const user = await User.findOne({ discordId: decoded.discordId })
        .select('-accessToken -refreshToken').lean();
      if (user) socket.emit('user_data', formatUserForClient(user));
    }
  } catch { /* 未登入，忽略 */ }

  socket.on('hello', async (msg) => {
    socket.role = msg.role || 'unknown';
    if (socket.role === 'atc') {
      ioAtcClients.add(socket);
      socket.emit('aircraft_snapshot', Array.from(aircrafts.values()).map(x => x.payload));
      for (const [aircraftId] of aircrafts) {
        const tracks = await loadHistoryForAircraft(aircraftId);
        if (tracks?.length) socket.emit('aircraft_track_history', { aircraftId, tracks });
      }
    }
    if (socket.role === 'player') {
      ioPlayerClients.add(socket);
      socket.aircraftId = null;
    }
  });

  socket.on('position_update', async (p) => {
    const id = p.id || (p.callsign ? p.callsign + ':' + (p.playerId || 'p') : null);
    if (!id) return;
    if (socket.role === 'player') socket.aircraftId = id;

    const payload = {
      id, callsign: p.callsign || 'UNK', type: p.type || '',
      lat: +p.lat || 0, lon: +p.lon || 0, alt: +p.alt || 0,
      heading: +p.heading || 0, speed: +p.speed || 0,
      flightNo: p.flightNo || '', userId: p.userId || null,
      departure: p.departure || '', arrival: p.arrival || '',
      takeoffTime: p.takeoffTime || '', squawk: p.squawk || '',
      flightPlan: p.flightPlan || [], ts: Date.now()
    };

    aircrafts.set(id, { payload, lastSeen: Date.now() });
    await saveFlightPoint({ aircraftId: id, callsign: payload.callsign, type: payload.type,
      lat: payload.lat, lon: payload.lon, alt: payload.alt,
      speed: payload.speed, heading: payload.heading, ts: payload.ts });
    try {
      await checkWaypointReminder(payload);
    } catch (err) {
      console.error('[Reminder] Socket.IO check failed:', err);
    }
    broadcastToATC({ type: 'aircraft_update', payload });
    await sendSquawkAlert(payload);
  });

  socket.on('disconnect', async () => {
    ioAtcClients.delete(socket);
    ioPlayerClients.delete(socket);
    if (socket.role === 'player' && socket.aircraftId) {
      await finalizeFlightSession(socket.aircraftId, 'completed');
      alertedSquawks.delete(socket.aircraftId);
      waypointState.delete(socket.aircraftId);
      broadcastToATC({ type: 'aircraft_track_clear', payload: { aircraftId: socket.aircraftId } });
    }
    console.log('Socket.IO client disconnected:', socket.id);
  });
});

// ============ WebSocket 分塊發送 ============
function sendInChunks(ws, aircraftId, tracks, chunkSize = 200) {
  if (!tracks.length) return;
  const totalChunks = Math.ceil(tracks.length / chunkSize);
  for (let i = 0; i < totalChunks; i++) {
    const chunk = tracks.slice(i * chunkSize, (i + 1) * chunkSize);
    ws.send(JSON.stringify({
      type: 'aircraft_track_history',
      payload: { aircraftId, tracks: chunk,
        chunkInfo: { current: i + 1, total: totalChunks, isLast: i === totalChunks - 1 } }
    }));
  }
  console.log(`[ATC] Sent ${tracks.length} history points (${totalChunks} chunks) for ${aircraftId}`);
}

// ============ WebSocket ============
server.on('upgrade', (request, socket, head) => {
  const pathname = new URL(request.url, 'http://localhost').pathname;
  if (pathname === '/ws' || pathname === '/') {
    wss.handleUpgrade(request, socket, head, (ws) => wss.emit('connection', ws, request));
  } else {
    socket.destroy();
  }
});

wss.on('connection', (ws) => {
  clients.add(ws);
  ws.role = 'unknown';
  console.log('WebSocket connected. total clients:', clients.size);

  ws.on('message', async (data) => {
    try {
      const msg = JSON.parse(data);

      if (msg.type === 'hello') {
        ws.role = msg.role || 'unknown';
        if (ws.role === 'atc') {
          atcClients.add(ws);
          ws.send(JSON.stringify({ type: 'aircraft_snapshot', payload: Array.from(aircrafts.values()).map(x => x.payload) }));
          for (const [aircraftId] of aircrafts) {
            const tracks = await loadHistoryForAircraft(aircraftId, 10000);
            if (tracks?.length) sendInChunks(ws, aircraftId, tracks, 200);
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
        if (ws.role === 'player') ws.aircraftId = id;

        const payload = {
          id, callsign: p.callsign || 'UNK', type: p.type || '',
          lat: +p.lat || 0, lon: +p.lon || 0, alt: +p.alt || 0,
          heading: (typeof p.heading !== 'undefined') ? +p.heading : 0,
          speed: (typeof p.speed !== 'undefined') ? +p.speed : 0,
          userId: p.userId || null, flightNo: p.flightNo || '',
          departure: p.departure || '', arrival: p.arrival || '',
          takeoffTime: p.takeoffTime || '', squawk: p.squawk || '',
          ts: Date.now(), flightPlan: p.flightPlan || []
        };

        aircrafts.set(id, { payload, lastSeen: Date.now() });
        await saveFlightPoint({ aircraftId: id, callsign: payload.callsign, type: payload.type,
          lat: payload.lat, lon: payload.lon, alt: payload.alt,
          speed: payload.speed, heading: payload.heading, ts: payload.ts });
        try {
          await checkWaypointReminder(payload);
        } catch (err) {
          console.error('[Reminder] WebSocket check failed:', err);
        }
        broadcastToATC({ type: 'aircraft_update', payload,
          trackPoint: { lat: payload.lat, lon: payload.lon, alt: payload.alt, timestamp: payload.ts } });
        await sendSquawkAlert(payload);
        return;
      }

      if (msg.type === 'clear_track' && msg.aircraftId) {
        await FlightPoint.deleteMany({ aircraftId: msg.aircraftId });
        broadcastToATC({ type: 'aircraft_track_clear', payload: { aircraftId: msg.aircraftId } });
        return;
      }

      if (msg.type === 'disconnect' && msg.aircraftId) {
        await finalizeFlightSession(msg.aircraftId, 'completed');
        waypointState.delete(msg.aircraftId);
        alertedSquawks.delete(msg.aircraftId);
        broadcastToATC({ type: 'aircraft_track_clear', payload: { aircraftId: msg.aircraftId } });
        return;
      }

    } catch (e) {
      console.warn('Bad WebSocket message', e);
    }
  });

  ws.on('close', async () => {
    clients.delete(ws);
    atcClients.delete(ws);
    playerClients.delete(ws);
    if (ws.role === 'player' && ws.aircraftId) {
      try {
        await finalizeFlightSession(ws.aircraftId, 'completed');
        alertedSquawks.delete(ws.aircraftId);
      } catch (err) {
        console.error('Error finalizing on close', err);
      }
      broadcastToATC({ type: 'aircraft_track_clear', payload: { aircraftId: ws.aircraftId } });
    }
    console.log('WebSocket closed. total clients:', clients.size);
  });

  ws.on('error', (e) => console.warn('WebSocket error', e));
});

// ============ Discord OAuth Routes ============

// Step 1：導向 Discord 授權頁
app.get('/auth/discord', (req, res) => {
  if (!DISCORD_CLIENT_ID) return res.status(500).send('Discord OAuth not configured');
  const state = Math.random().toString(36).slice(2);
  res.cookie('discord_oauth_state', state, { httpOnly: true, maxAge: 300_000 });
  const params = new URLSearchParams({
    client_id: DISCORD_CLIENT_ID,
    redirect_uri: DISCORD_REDIRECT_URI,
    response_type: 'code',
    scope: 'identify',
    state
  });
  res.redirect(`https://discord.com/api/oauth2/authorize?${params}`);
});

// Step 2：OAuth Callback
app.get('/auth/discord/callback', async (req, res) => {
  try {
    const { code, state } = req.query;
    if (!code) return res.status(400).send('No code provided');
    if (state !== req.cookies.discord_oauth_state) return res.status(400).send('State mismatch');

    // 兌換 Token
    const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: DISCORD_CLIENT_ID,
        client_secret: DISCORD_CLIENT_SECRET,
        grant_type: 'authorization_code',
        code, redirect_uri: DISCORD_REDIRECT_URI
      })
    });
    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) return res.status(400).send('Token exchange failed');

    // 取得 Discord 用戶資料
    const userRes = await fetch('https://discord.com/api/users/@me', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` }
    });
    const du = await userRes.json();

    const avatarUrl = du.avatar
      ? `https://cdn.discordapp.com/avatars/${du.id}/${du.avatar}.png`
      : `https://cdn.discordapp.com/embed/avatars/${Number(du.discriminator || 0) % 5}.png`;

    // 查是否已有此用戶（保留原有 apiKey、admin 設定）
    const existing = await User.findOne({ discordId: du.id });

    const user = await User.findOneAndUpdate(
      { discordId: du.id },
      {
        $set: {
          discordId:     du.id,
          username:      du.username,
          displayName:   du.global_name || du.username,
          discriminator: du.discriminator || '0',
          photos:        [avatarUrl],
          accessToken:   tokenData.access_token,
          refreshToken:  tokenData.refresh_token || null
        },
        // 首次登入才產生 API Key
        $setOnInsert: { apiKey: generateApiKey() }
      },
      { upsert: true, new: true }
    );

    // 發放 JWT
    const token = jwt.sign(
      { discordId: user.discordId, username: user.username },
      JWT_SECRET,
      { expiresIn: '30d' }
    );
    res.clearCookie('discord_oauth_state');
    res.cookie('auth_token', token, { httpOnly: true, maxAge: 30 * 24 * 60 * 60 * 1000 });
    res.redirect('/?discord_linked=1');
  } catch (err) {
    console.error('Discord OAuth error', err);
    res.status(500).send('OAuth error: ' + err.message);
  }
});

// 登出
// GET 跳轉登出（前端用 <a href="/auth/logout"> ）
app.get('/auth/logout', (req, res) => {
  res.clearCookie('auth_token');
  res.redirect('/');
});
// POST 登出（API 呼叫用）
app.post('/auth/logout', (req, res) => {
  res.clearCookie('auth_token');
  res.json({ ok: true });
});

// ============ User API Routes ============

// 取得目前登入用戶（前端呼叫 /api/user/me）
app.get('/api/user/me', authMiddleware, async (req, res) => {
  try {
    const user = await User.findOne({ discordId: req.jwtUser.discordId })
      .select('-accessToken -refreshToken').lean();
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json(formatUserForClient(user));
  } catch { res.status(500).json({ error: 'server error' }); }
});

// 重新產生 API Key
app.post('/api/user/regenerate-key', authMiddleware, async (req, res) => {
  try {
    const newKey = generateApiKey();
    await User.findOneAndUpdate(
      { discordId: req.jwtUser.discordId },
      { apiKey: newKey }
    );
    res.json({ apiKey: newKey });
  } catch { res.status(500).json({ error: 'server error' }); }
});

// 綁定 GeoFS userId ↔ Discord 帳號
app.post('/api/user/link', authMiddleware, async (req, res) => {
  try {
    const { geofsUserId } = req.body;
    if (!geofsUserId) return res.status(400).json({ error: 'geofsUserId required' });
    await User.findOneAndUpdate(
      { discordId: req.jwtUser.discordId },
      { geofsUserId: String(geofsUserId), linkedAt: new Date() }
    );
    res.json({ ok: true });
  } catch { res.status(500).json({ error: 'server error' }); }
});

// 取得個人飛行紀錄（需登入）
app.get('/api/my-flights', authMiddleware, async (req, res) => {
  try {
    const user = await User.findOne({ discordId: req.jwtUser.discordId }).lean();
    if (!user) return res.status(404).json({ error: 'User not found' });
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const flights = await FlightSession.find({ discordId: user.discordId })
      .sort({ startTime: -1 }).limit(limit).lean();
    res.json(flights);
  } catch { res.status(500).json({ error: 'server error' }); }
});

// 取得任一用戶公開資料
app.get('/api/users/:discordId', async (req, res) => {
  try {
    const user = await User.findOne({ discordId: req.params.discordId })
      .select('discordId username displayName photos geofsUserId createdAt').lean();
    if (!user) return res.status(404).json({ error: 'not found' });
    res.json(user);
  } catch { res.status(500).json({ error: 'server error' }); }
});

// ============ Flight History API Routes ============

// 所有歷史飛行（含分頁 & 篩選）
app.get('/api/flights/history', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);
    const page  = Math.max(parseInt(req.query.page)  || 0,  0);
    const filter = {};
    if (req.query.callsign)  filter.callsign  = new RegExp(req.query.callsign, 'i');
    if (req.query.discordId) filter.discordId = req.query.discordId;
    if (req.query.departure) filter.departure = req.query.departure.toUpperCase();
    if (req.query.arrival)   filter.arrival   = req.query.arrival.toUpperCase();

    const [flights, total] = await Promise.all([
      FlightSession.find(filter).sort({ startTime: -1 }).skip(page * limit).limit(limit).select('-trackSnapshot').lean(),
      FlightSession.countDocuments(filter)
    ]);
    res.json({ flights, total, page, limit, pages: Math.ceil(total / limit) });
  } catch { res.status(500).json({ error: 'server error' }); }
});

// 特定用戶的歷史飛行（by discordId）
app.get('/api/flights/user/:discordId', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);
    const flights = await FlightSession.find({ discordId: req.params.discordId })
      .sort({ startTime: -1 }).limit(limit).select('-trackSnapshot').lean();
    res.json(flights);
  } catch { res.status(500).json({ error: 'server error' }); }
});

// 特定用戶的歷史飛行（by geofsUserId）
app.get('/api/flights/geofs/:geofsUserId', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);
    const flights = await FlightSession.find({ geofsUserId: req.params.geofsUserId })
      .sort({ startTime: -1 }).limit(limit).select('-trackSnapshot').lean();
    res.json(flights);
  } catch { res.status(500).json({ error: 'server error' }); }
});

// 單次飛行詳情（含完整軌跡）
app.get('/api/flights/:sessionId', async (req, res) => {
  try {
    const flight = await FlightSession.findById(req.params.sessionId).lean();
    if (!flight) return res.status(404).json({ error: 'not found' });
    res.json(flight);
  } catch { res.status(500).json({ error: 'server error' }); }
});

// 飛行統計（by discordId）
app.get('/api/flights/stats/:discordId', async (req, res) => {
  try {
    const stats = await FlightSession.aggregate([
      { $match: { discordId: req.params.discordId } },
      { $group: {
        _id: '$discordId',
        totalFlights:    { $sum: 1 },
        totalDistanceNm: { $sum: '$distanceNm' },
        totalDuration:   { $sum: '$duration' },
        maxAlt:          { $max: '$maxAlt' },
        maxSpeed:        { $max: '$maxSpeed' }
      }}
    ]);
    res.json(stats[0] || { totalFlights: 0, totalDistanceNm: 0, totalDuration: 0 });
  } catch { res.status(500).json({ error: 'server error' }); }
});

// 刪除飛行紀錄（管理員）
app.get('/api/whois/:callsign', async (req, res) => {
  try {
    const callsign = String(req.params.callsign || '').trim().toUpperCase();
    const normalizedQuery = normalizeFlightLookup(callsign);
    if (!normalizedQuery) return res.status(400).json({ error: 'Callsign is required' });

    const live = Array.from(aircrafts.values()).find(({ payload }) =>
      normalizeFlightLookup(payload?.callsign) === normalizedQuery ||
      normalizeFlightLookup(payload?.flightNo) === normalizedQuery
    );

    if (!live?.payload) {
      return res.status(404).json({ error: 'Live aircraft not found' });
    }

    const geofsUserId = live.payload.userId ? String(live.payload.userId).trim() : null;
    const user = geofsUserId ? await User.findOne({ geofsUserId }).lean() : null;

    res.json({
      live: true,
      callsign,
      aircraft: {
        callsign: live.payload.callsign || callsign,
        flightNo: live.payload.flightNo || '',
        type: live.payload.type || '',
        departure: live.payload.departure || '',
        arrival: live.payload.arrival || '',
        geofsUserId,
        discordId: user?.discordId || null,
        username: user?.username || null,
        displayName: user?.displayName || null,
        lastSeen: live.lastSeen || Date.now(),
      }
    });
  } catch (err) {
    console.error('GET /api/whois/:callsign error', err);
    res.status(500).json({ error: 'Failed to lookup callsign' });
  }
});

app.delete('/admin/flights/:sessionId', checkAdminPass, async (req, res) => {
  try {
    await FlightSession.findByIdAndDelete(req.params.sessionId);
    res.json({ ok: true });
  } catch { res.status(500).json({ error: 'server error' }); }
});

// ============ Airline Registry API ============
app.post('/api/airline', async (req, res) => {
  try {
    if (!AIRLINE_WEBHOOK_URL) return res.status(500).json({ error: 'Webhook not configured' });
    const { icao, iata, name, country, logo } = req.body;
    if (!icao || !iata || !name || !country)
      return res.status(400).json({ error: 'Missing required fields: icao, iata, name, country' });

    const entry = { name, icao, iata, country };
    if (logo) entry.logo = logo;
    const jsonStr = JSON.stringify({ [icao]: entry }, null, 2);

    const webhookRes = await fetch(AIRLINE_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'Airline Registry',
        avatar_url: 'https://i.ibb.co/fzm8m0LS/geofs-flightradar.webp',
        embeds: [{
          title: `✈ New Airline — ${name}`,
          color: 0xf0a500,
          fields: [
            { name: 'ICAO', value: `\`${icao}\``, inline: true },
            { name: 'IATA', value: `\`${iata}\``, inline: true },
            { name: 'Country', value: country, inline: true },
            { name: 'JSON Payload', value: `\`\`\`json\n${jsonStr}\n\`\`\`` }
          ],
          ...(logo && { thumbnail: { url: logo } }),
          footer: { text: `Airline Registry · ${new Date().toISOString()}` }
        }]
      })
    });
    if (!webhookRes.ok) {
      const errText = await webhookRes.text();
      return res.status(502).json({ error: `Discord error: ${webhookRes.status} ${errText}` });
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('Airline API error:', err);
    res.status(500).json({ error: err.message || 'server error' });
  }
});

// ============ Photo Admin Routes ============
app.get('/admin/photos/pending', checkAdminPass, async (req, res) => {
  try { res.json(await Photo.find({ status: 'pending' }).sort({ createdAt: -1 })); }
  catch { res.status(500).json({ error: 'server error' }); }
});
app.post('/admin/photos/:id/approve', checkAdminPass, async (req, res) => {
  try {
    const photo = await Photo.findById(req.params.id);
    if (!photo) return res.status(404).json({ error: 'not found' });
    photo.status = 'approved'; await photo.save(); res.json({ message: 'approved' });
  } catch { res.status(500).json({ error: 'server error' }); }
});
app.post('/admin/photos/:id/reject', checkAdminPass, async (req, res) => {
  try {
    const photo = await Photo.findById(req.params.id);
    if (!photo) return res.status(404).json({ error: 'not found' });
    photo.status = 'rejected'; await photo.save(); res.json({ message: 'rejected' });
  } catch { res.status(500).json({ error: 'server error' }); }
});
app.delete('/admin/photos/:id', checkAdminPass, async (req, res) => {
  try { await Photo.findByIdAndDelete(req.params.id); res.json({ message: 'deleted' }); }
  catch { res.status(500).json({ error: 'server error' }); }
});

// ============ Photo Public Routes ============
app.get('/api/photos', async (req, res) => {
  try { res.json(await Photo.find({ status: 'approved' }).sort({ createdAt: -1 })); }
  catch { res.status(500).json({ error: 'server error' }); }
});
app.get('/api/photos/user/:userId', async (req, res) => {
  try {
    res.json(await Photo.find({ userId: req.params.userId, status: 'approved' }).sort({ createdAt: -1 }).limit(10));
  } catch { res.status(500).json({ error: 'server error' }); }
});

// ============ Live Track Routes ============
app.delete('/clear/:aircraftId', async (req, res) => {
  try {
    await FlightPoint.deleteMany({ aircraftId: req.params.aircraftId });
    broadcastToATC({ type: 'aircraft_track_clear', payload: { aircraftId: req.params.aircraftId } });
    res.sendStatus(200);
  } catch { res.status(500).json({ error: 'server error' }); }
});

app.get('/api/tracks/all', async (req, res) => {
  try {
    const startTime = parseInt(req.query.start) || (Date.now() - 6 * 60 * 60 * 1000);
    const docs = await FlightPoint.find({ ts: { $gte: startTime } })
      .sort({ ts: 1 }).lean();
    const grouped = {};
    docs.forEach(d => {
      if (!grouped[d.aircraftId]) grouped[d.aircraftId] = [];
      grouped[d.aircraftId].push({ lat: d.lat, lon: d.lon, alt: d.alt || 0, speed: d.speed || 0, ts: d.ts });
    });
    Object.keys(grouped).forEach(id => { grouped[id] = simplifyTrack(grouped[id], 2000); });
    res.json(grouped);
  } catch { res.status(500).json({ error: 'Failed to fetch all tracks' }); }
});

app.get('/api/tracks/:aircraftId', async (req, res) => {
  try {
    const { aircraftId } = req.params;
    const startTime = parseInt(req.query.start) || (Date.now() - 6 * 60 * 60 * 1000);
    const docs = await FlightPoint.find({ aircraftId, ts: { $gte: startTime } })
      .sort({ ts: 1 }).limit(20000).lean();
    const tracks = docs.map(d => ({ lat: d.lat, lon: d.lon, alt: d.alt || 0, speed: d.speed || 0, ts: d.ts }));
    res.json({ tracks });
  } catch { res.status(500).json({ error: 'Failed to fetch tracks' }); }
});

// ============ Upload ============
const UPLOAD_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR);

const storage = multer.diskStorage({
  destination: UPLOAD_DIR,
  filename: (req, file, cb) => {
    const ext = mime.extension(file.mimetype) || 'jpg';
    cb(null, Date.now() + '-' + Math.random().toString(36).slice(2, 9) + '.' + ext);
  }
});
const upload = multer({ storage, limits: { fileSize: 30 * 1024 * 1024 } });

app.post('/api/upload', upload.single('photo'), async (req, res) => {
  try {
    const file = req.file;
    if (!file) return res.status(400).json({ error: 'no file' });
    if (!IMGBB_API_KEY) return res.status(500).json({ error: 'ImgBB API key not configured' });

    const formData = new FormData();
    formData.append('image', fs.readFileSync(file.path).toString('base64'));
    const imgbbResponse = await fetch(`https://api.imgbb.com/1/upload?key=${IMGBB_API_KEY}`, { method: 'POST', body: formData });
    const imgbbData = await imgbbResponse.json();
    if (!imgbbData.success) throw new Error('ImgBB upload failed: ' + (imgbbData.error?.message || 'unknown'));
    fs.unlinkSync(file.path);

    const { photographer = 'anon', caption = '', tags = '', lat, lon, userId } = req.body;
    const photo = await Photo.create({
      file: imgbbData.data.url, thumb: imgbbData.data.url,
      photographer, caption,
      tags: tags.split(',').map(s => s.trim()).filter(Boolean),
      lat: lat ? Number(lat) : null, lon: lon ? Number(lon) : null,
      userId: userId || null, status: 'pending'
    });
    res.json({ ok: true, photo });
  } catch (err) {
    console.error('Upload error:', err);
    res.status(500).json({ error: err.message || 'server error' });
  }
});

// ============ Static Routes ============
app.use(express.static(path.join(__dirname, 'public')));
app.get('/',             (req, res) => res.sendFile(path.join(__dirname, 'public', 'atc.html')));
app.get('/admin.html',   (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/upload.html',  (req, res) => res.sendFile(path.join(__dirname, 'public', 'upload.html')));
app.get('/gallery.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'gallery.html')));
app.get('/photomap.html',(req, res) => res.sendFile(path.join(__dirname, 'public', 'photomap.html')));
app.get('/airline.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'airline.html')));
app.get('/airlines.json',(req, res) => res.sendFile(path.join(__dirname, 'airlines.json')));
app.get('/history.html',(req, res) => res.sendFile(path.join(__dirname, 'public', 'history.html')));
app.get('/health',       (req, res) => res.send('ok'));

// ============ 定期清理 ============

// 清理逾時飛機（30 秒）
setInterval(async () => {
  const now = Date.now();
  const removed = [];
  for (const [id, v] of aircrafts.entries()) {
    if (now - v.lastSeen > 30_000) {
      aircrafts.delete(id);
      removed.push(id);
      try {
        await finalizeFlightSession(id, 'aborted');
        alertedSquawks.delete(id);
      } catch (err) {
        console.error('cleanup error', err);
      }
    }
  }
  if (removed.length) {
    broadcastToATC({ type: 'aircraft_remove', payload: removed });
    removed.forEach(aircraftId =>
      broadcastToATC({ type: 'aircraft_track_clear', payload: { aircraftId } })
    );
  }
}, 5000);

// 清理過期 FlightPoint（每 6 小時）
setInterval(async () => {
  try {
    await FlightPoint.deleteMany({ ts: { $lt: Date.now() - RETENTION_MS } });
  } catch (err) {
    console.error('Prune error', err);
  }
}, 6 * 60 * 60 * 1000);

// ============ 啟動 ============
server.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Server listening on port ${PORT}`);
  console.log(`✅ WebSocket:      wss://geofs-flightradar.duckdns.org/ws`);
  console.log(`✅ Socket.IO:      https://geofs-flightradar.duckdns.org/socket.io/`);
  console.log(`✅ Discord OAuth:  /auth/discord`);
  console.log(`✅ Flight History: /api/flights/history`);
});