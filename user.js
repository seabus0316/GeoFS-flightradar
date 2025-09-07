// ==UserScript==
// @name         GeoFS ATC Reporter
// @namespace    http://tampermonkey.net/
// @version      1.3
// @description  This plugin will send your airct=raft info to the server
// @match        https://geo-fs.com/*
// @match        https://*.geo-fs.com/*
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  /*** CONFIG ***/
  // 本地測試改成你的 WebSocket 端點
  const WS_URL = 'https://geofs-flightradar.onrender.com/';
  const SEND_INTERVAL_MS = 1000;
  /*************/

  function log(...args) {
    console.log('[ATC-Reporter]', ...args);
  }

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
  // 參考你的 Information Display 寫法：
  // AGL ≈ (MSL高度 - 地面高程feet) + 機體碰撞點Z位移(轉英尺)，最後四捨五入。:contentReference[oaicite:1]{index=1}
  function calculateAGL() {
    try {
      const altitudeMSL = geofs?.animation?.values?.altitude; // feet (GeoFS 已是英尺)
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

      // MSL 以英尺為主要傳輸單位
      const altMSL = (typeof altMeters === 'number') ? altMeters * 3.28084 : geofs?.animation?.values?.altitude ?? 0;
      const altAGL = calculateAGL();

      // Heading / Speed 防呆
      const heading = geofs?.animation?.values?.heading360 ?? 0;
      // 地速建議用 animation.values.groundSpeed（單位 knots）
      const speed = geofs?.animation?.values?.groundSpeed ?? inst?.groundSpeed ?? 0;

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

  // --- 組裝送出的 payload ---
  // 依你的需求：server 收到的 alt 就是 AGL；同時附帶 altMSL 方便伺服端比對/顯示
  function buildPayload(snap) {
    return {
      id: getPlayerCallsign(),
      callsign: getPlayerCallsign(),
      type: getAircraftName(),
      lat: snap.lat,
      lon: snap.lon,
      alt: (typeof snap.altAGL === 'number') ? snap.altAGL : Math.round(snap.altMSL || 0), // ALT = AGL（優先），fallback MSL
      altMSL: Math.round(snap.altMSL || 0),
      heading: Math.round(snap.heading || 0),
      speed: Math.round(snap.speed || 0)
    };
  }

  // --- 週期傳送 ---
  setInterval(() => {
    if (!ws || ws.readyState !== 1) return;
    const snap = readSnapshot();
    if (!snap) return;
    const payload = buildPayload(snap);
    safeSend({ type: 'position_update', payload });
  }, SEND_INTERVAL_MS);

  // --- 介面提醒 ---
  function injectBadge() {
    const d = document.createElement('div');
    d.style.position = 'fixed';
    d.style.right = '6px';
    d.style.bottom = '6px';
    d.style.padding = '6px 8px';
    d.style.background = 'rgba(0,0,0,0.6)';
    d.style.color = 'white';
    d.style.fontSize = '12px';
    d.style.borderRadius = '6px';
    d.style.zIndex = 999999;
    d.textContent = 'ATC Reporter Running (ALT = AGL)';
    document.body.appendChild(d);
    setTimeout(() => { d.style.opacity = '0.7'; }, 2000);
  }
  injectBadge();
})();


