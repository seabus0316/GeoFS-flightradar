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

// Helper: broadcast to atc clients
function broadcastToATC(obj) {
  const msg = JSON.stringify(obj);
  for (const ws of atcClients) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(msg);
    }
  }
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
          const payload = Array.from(aircrafts.values()).map(x => x.payload);
          ws.send(JSON.stringify({ type: 'aircraft_snapshot', payload }));
        } else if (ws.role === 'player') {
          playerClients.add(ws);
        }
        return;
      }

      if (msg.type === 'position_update' && msg.payload) {
        const p = msg.payload;
        const id = p.id || (p.callsign ? p.callsign + ':' + (p.playerId||'p') : null);
        if (!id) return;
        const payload = {
          id,
          callsign: p.callsign || 'UNK',
          type: p.type || '',
          lat: +p.lat || 0,
          lon: +p.lon || 0,
          alt: +p.alt || 0,
          heading: (typeof p.heading !== 'undefined') ? +p.heading : 0,
          speed: (typeof p.speed !== 'undefined') ? +p.speed : 0,
          ts: Date.now()
        };
        aircrafts.set(id, { payload, lastSeen: Date.now() });
        broadcastToATC({ type: 'aircraft_update', payload });
      }
    } catch (e) {
      console.warn('Bad message', e);
    }
  });

  ws.on('close', () => {
    clients.delete(ws);
    atcClients.delete(ws);
    playerClients.delete(ws);
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
      removed.push(id);
    }
  }
  if (removed.length) {
    broadcastToATC({ type: 'aircraft_remove', payload: removed });
  }
}, 5000);

server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
