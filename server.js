
require("dotenv").config();
const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const mongoose = require("mongoose");
const path = require("path");

// ---------------- CONFIG ----------------
const PORT = process.env.PORT || 10000;
const MONGODB_URI =
  process.env.MONGODB_URI ||
  "mongodb://localhost:27017/geofs_flightradar";
const RETENTION_MS = 12 * 60 * 60 * 1000; // 12h

// ---------------- SETUP ----------------
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true });

// ---------------- DATABASE ----------------
const flightPointSchema = new mongoose.Schema({
  aircraftId: String,
  lat: Number,
  lon: Number,
  alt: Number,
  spd: Number,
  hdg: Number,
  ts: Number,
});
const FlightPoint = mongoose.model("FlightPoint", flightPointSchema);

async function connectWithRetry() {
  try {
    await mongoose.connect(MONGODB_URI);
    console.log("✅ MongoDB connected");
  } catch (err) {
    console.error("❌ MongoDB connect error", err.message);
    console.log("Retrying in 5s...");
    setTimeout(connectWithRetry, 5000);
  }
}
connectWithRetry();

// ---------------- IN-MEMORY TRACKING ----------------
const aircrafts = new Map();

// ---------------- EXPRESS ----------------
app.use(express.json());
app.use(express.static(path.join(__dirname)));

app.get("/health", (_, res) => res.send("ok"));

// ---------------- WEBSOCKET UPGRADE ----------------
server.on("upgrade", (req, socket, head) => {
  if (req.url === "/ws") {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  } else {
    socket.destroy();
  }
});

// ---------------- WEBSOCKET HANDLING ----------------
wss.on("connection", async (ws) => {
  console.log("🛰️ ATC connected, sending current aircraft + history");

  // 1️⃣ 傳目前所有正在空中的飛機（記憶體內）
  ws.send(
    JSON.stringify({
      type: "aircraft_list",
      payload: Array.from(aircrafts.values()),
    })
  );

  // 2️⃣ 從 MongoDB 撈過去 24 小時的歷史紀錄
  try {
    const sixHoursAgo = Date.now() - 4*6 * 60 * 60 * 1000;
    const points = await FlightPoint.find({ ts: { $gt: sixHoursAgo } }).sort({
      ts: 1,
    });

    // 3️⃣ 按 aircraftId 分組
    const grouped = {};
    for (const p of points) {
      if (!grouped[p.aircraftId]) grouped[p.aircraftId] = [];
      grouped[p.aircraftId].push(p);
    }

    // 4️⃣ 發送每架飛機的歷史軌跡
    for (const [aircraftId, history] of Object.entries(grouped)) {
      ws.send(
        JSON.stringify({
          type: "aircraft_track_history",
          payload: { aircraftId, points: history },
        })
      );
    }

    console.log(`📦 Sent ${Object.keys(grouped).length} aircraft histories`);
  } catch (err) {
    console.error("❌ Error sending history:", err);
  }
});

// ---------------- API FOR PILOTS ----------------
app.post("/report", async (req, res) => {
  try {
    const data = req.body;
    const {
      aircraftId,
      lat,
      lon,
      alt,
      spd,
      hdg,
      ts = Date.now(),
    } = data;

    // 更新記憶體
    aircrafts.set(aircraftId, { aircraftId, lat, lon, alt, spd, hdg, ts, lastSeen: ts });

    // 寫入 MongoDB
    await FlightPoint.create({ aircraftId, lat, lon, alt, spd, hdg, ts });

    // 廣播給所有 ATC
    broadcastToATC({
      type: "aircraft_update",
      payload: { aircraftId, lat, lon, alt, spd, hdg, ts },
    });

    res.status(200).send("ok");
  } catch (err) {
    console.error("❌ report error", err);
    res.status(500).send("error");
  }
});

// ---------------- UTILITIES ----------------
function broadcastToATC(msg) {
  const json = JSON.stringify(msg);
  wss.clients.forEach((c) => {
    if (c.readyState === WebSocket.OPEN) c.send(json);
  });
}

// ---------------- CLEANUP ----------------
setInterval(async () => {
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
    broadcastToATC({ type: "aircraft_remove", payload: removed });
  }
}, 5000);

// 每 6 小時清除 12 小時前的紀錄
setInterval(async () => {
  const cutoff = Date.now() - RETENTION_MS;
  await FlightPoint.deleteMany({ ts: { $lt: cutoff } });
  console.log("🧹 Cleaned up old records");
}, 6 * 60 * 60 * 1000);

// ---------------- START SERVER ----------------
server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});

