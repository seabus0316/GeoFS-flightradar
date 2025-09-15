// server.js
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true });

const PORT = process.env.PORT || 3000;

// 直接把首頁 serve 成 atc.html
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'atc.html'));
});

// simple healthcheck
app.get('/health', (req, res) => res.send('ok'));

// --- WebSocket upgrade handling ---
server.on('upgrade', (request, socket, head) => {
  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit('connection', ws, request);
  });
});

// connection bookkeeping
const clients = new Set(); // all ws clients
const atcClients = new Set();
const playerClients = new Set();

// track aircraft state keyed by aircraft id
const aircrafts = new Map();

// 🔥 儲存歷史軌跡
const aircraftTracks = new Map(); // 每架飛機的歷史軌跡點
const MAX_TRACK_AGE_MS = 12 * 60 * 60 * 1000; // 保留 12 小時

// Helper: broadcast to atc clients
function broadcastToATC(obj) {
  const msg = JSON.stringify(obj);
  for (const ws of atcClients) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(msg);
    }
  }
}

// 儲存軌跡點，並清掉 12 小時前的
function addTrackPoint(aircraftId, lat, lon, alt, timestamp) {
  if (!aircraftTracks.has(aircraftId)) {
    aircraftTracks.set(aircraftId, []);
  }

  const tracks = aircraftTracks.get(aircraftId);
  tracks.push({ lat, lon, alt, timestamp });

  // 移除超過 12 小時的舊點
  const cutoff = Date.now() - MAX_TRACK_AGE_MS;
  while (tracks.length > 0 && tracks[0].timestamp < cutoff) {
    tracks.shift();
  }
}

// 清除飛機的歷史
function clearAircraftTrack(aircraftId) {
  aircraftTracks.delete(aircraftId);
  console.log(`Cleared track history for aircraft: ${aircraftId}`);
}

// On incoming websocket connection
wss.on('connection', (ws, req) => {
  clients.add(ws);
  ws.role = 'unknown';
  console.log('WS connected. total clients:', clients.size);

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data);
      if (msg.type === 'hello') {
        ws.role = msg.role || 'unknown';
        if (ws.role === 'atc') {
          atcClients.add(ws);

          // 發送當前飛機狀態
          const payload = Array.from(aircrafts.values()).map(x => x.payload);
          ws.send(JSON.stringify({ type: 'aircraft_snapshot', payload }));

          // 發送所有飛機的歷史軌跡
          for (const [aircraftId, tracks] of aircraftTracks.entries()) {
            if (tracks.length > 0) {
              ws.send(JSON.stringify({
                type: 'aircraft_track_history',
                payload: { aircraftId, tracks }
              }));
            }
          }

        } else if (ws.role === 'player') {
          playerClients.add(ws);
          ws.aircraftId = null; // 將在收到第一個位置更新時設置
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
          ts: Date.now()
        };

        // 更新飛機狀態
        aircrafts.set(id, { payload, lastSeen: Date.now() });

        // 儲存軌跡點（保留 12 小時內）
        addTrackPoint(id, payload.lat, payload.lon, payload.alt, payload.ts);

        // 廣播更新
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
      }
    } catch (e) {
      console.warn('Bad message', e);
    }
  });

  ws.on('close', () => {
    clients.delete(ws);
    atcClients.delete(ws);
    playerClients.delete(ws);

    // 🔥 玩家斷線 → 清除其軌跡
    if (ws.role === 'player' && ws.aircraftId) {
      clearAircraftTrack(ws.aircraftId);
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

// cleanup stale aircrafts periodically
setInterval(() => {
  const now = Date.now();
  const timeout = 30000; // 30s
  let removed = [];
  for (const [id, v] of aircrafts.entries()) {
    if (now - v.lastSeen > timeout) {
      aircrafts.delete(id);
      clearAircraftTrack(id); // 一併清掉歷史
      removed.push(id);
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

server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
