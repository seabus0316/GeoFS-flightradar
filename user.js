// ==UserScript==
// @name         GeoFS ATC Reporter
// @namespace    http://tampermonkey.net/
// @version      1.4
// @description  傳送位置到 ATC Server，並將畫面上的三角形換成自訂圖示 (PNG/SVG)
// @match        https://geo-fs.com/*
// @match        https://*.geo-fs.com/*
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  /*** CONFIG ***/
  const WS_URL = 'https://geofs-flightradar.onrender.com/';
  const SEND_INTERVAL_MS = 1000;

  // 換成你自己的圖示網址（PNG / SVG）
  const ICON_URL = "https://i.ibb.co/B5x4wVTz/monajinping.png";
  const ICON_SIZE = 32; // 圖示大小（像素）
  /*************/

  function log(...args) {
    console.log('[ATC-Reporter]', ...args);
  }

  // --- 載入 icon ---
  const planeIcon = new Image();
  let planeIconLoaded = false;
  planeIcon.src = ICON_URL;
  planeIcon.onload = () => {
    planeIconLoaded = true;
    log("Plane icon loaded:", ICON_URL);
  };

  // --- WebSocket 管理 ---
  let ws;
  function connect() {
    try {
      ws = new WebSocket(WS_URL);
      ws.addEventListener('open', () => {
        log('WS connected');
        safeSend({ type: 'hello', role: 'player' });
      });
      ws.addEventListener('close', () => {
        log('WS closed, retrying...');
        setTimeout(connect, 2000);
      });
      ws.addEventListener('error', (e) => {
        console.warn('[ATC-Reporter] WS error', e);
        try { ws.close(); } catch {}
      });
    } catch (e) {
      console.warn('[ATC-Reporter] WS connect error', e);
      setTimeout(connect, 2000);
    }
  }
  connect();

  function safeSend(obj) {
    try {
      if (ws && ws.readyState === 1) {
        ws.send(JSON.stringify(obj));
      }
    } catch (e) {
      console.warn('[ATC-Reporter] send error', e);
    }
  }

  // --- 便利函式 ---
  function getAircraftName() {
    return geofs?.aircraft?.instance?.aircraftRecord?.name || 'Unknown';
  }

  function getPlayerCallsign() {
    return geofs?.userRecord?.callsign || 'Unknown';
  }

  // --- AGL 計算 ---
  function calculateAGL() {
    try {
      const altitudeMSL = geofs?.animation?.values?.altitude; // feet
      const groundElevationFeet = geofs?.animation?.values?.groundElevationFeet; // feet
      const aircraft = geofs?.aircraft?.instance;

      if (
        typeof altitudeMSL === 'number' &&
        typeof groundElevationFeet === 'number' &&
        aircraft?.collisionPoints?.length >= 2 &&
        typeof aircraft.collisionPoints[aircraft.collisionPoints.length - 2]?.worldPosition?.[2] === 'number'
      ) {
        const collisionZFeet = aircraft.collisionPoints[aircraft.collisionPoints.length - 2].worldPosition[2] * 3.2808399;
        const agl = Math.round((altitudeMSL - groundElevationFeet) + collisionZFeet);
        return agl;
      }
    } catch (err) {
      console.warn('[ATC-Reporter] AGL calculation error:', err);
    }
    return null;
  }

  // --- 取位置與姿態 ---
  function readSnapshot() {
    try {
      const inst = geofs?.aircraft?.instance;
      if (!inst) return null;

      const lla = inst.llaLocation || [];
      const lat = lla[0];
      const lon = lla[1];
      const altMeters = lla[2];

      if (typeof lat !== 'number' || typeof lon !== 'number') return null;

      const altMSL = (typeof altMeters === 'number') ? altMeters * 3.28084 : geofs?.animation?.values?.altitude ?? 0;
      const altAGL = calculateAGL();
      const heading = geofs?.animation?.values?.heading360 ?? 0;
      const speed = geofs.animation.values.kias?? 0;

      return {
        lat,
        lon,
        altMSL,
        altAGL,
        heading,
        speed
      };
    } catch (e) {
      console.warn('[ATC-Reporter] readSnapshot error:', e);
      return null;
    }
  }

  function buildPayload(snap) {
    return {
      id: getPlayerCallsign(),
      callsign: getPlayerCallsign(),
      type: getAircraftName(),
      lat: snap.lat,
      lon: snap.lon,
      alt: (typeof snap.altAGL === 'number') ? snap.altAGL : Math.round(snap.altMSL || 0),
      altMSL: Math.round(snap.altMSL || 0),
      heading: Math.round(snap.heading || 0),
      speed: Math.round(snap.speed || 0)
    };
  }

  setInterval(() => {
    if (!ws || ws.readyState !== 1) return;
    const snap = readSnapshot();
    if (!snap) return;
    const payload = buildPayload(snap);
    safeSend({ type: 'position_update', payload });
  }, SEND_INTERVAL_MS);

  // --- 改圖標繪製 ---
  function drawPlaneIcon(ctx, x, y, heading) {
    if (!planeIconLoaded) return;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate((heading || 0) * Math.PI / 180);
    ctx.drawImage(planeIcon, -ICON_SIZE/2, -ICON_SIZE/2, ICON_SIZE, ICON_SIZE);
    ctx.restore();
  }

  // 假設 addon 原本有一個 onrender 畫三角形，這裡替換成 drawPlaneIcon
  if (geofs.api) {
    geofs.api.addRenderListener(() => {
      try {
        const snap = readSnapshot();
        if (!snap) return;

        // 投影到畫布座標 (示意，需依你的 addon 原始程式的 map/screen 座標轉換方式)
        const canvas = document.querySelector("canvas");
        if (!canvas) return;
        const ctx = canvas.getContext("2d");

        // 這裡示意直接畫在螢幕中央
        const px = canvas.width / 2;
        const py = canvas.height / 2;

        drawPlaneIcon(ctx, px, py, snap.heading);
      } catch (e) {
        console.warn("[ATC-Reporter] draw icon error", e);
      }
    });
  }
})();
