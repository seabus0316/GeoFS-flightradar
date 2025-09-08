// ==UserScript==
// @name         GeoFS ATC Reporter (Enhanced, AGL-as-ALT + Flight Info UI)
// @namespace    http://tampermonkey.net/
// @version      1.4
// @description  傳送玩家位置和航班資訊到 ATC Server；ALT=AGL；UI可輸入Dep/Arr/FlightNo；按W隱藏UI
// @match        https://geo-fs.com/*
// @match        https://*.geo-fs.com/*
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  /*** CONFIG ***/
  const WS_URL = 'https://geofs-flightradar.onrender.com/'; // 本地測試
  const SEND_INTERVAL_MS = 1000;
  /*************/

  function log(...args) {
    console.log('[ATC-Reporter]', ...args);
  }

  // --- 航班資訊變數 ---
  let flightInfo = {
    departure: '',
    arrival: '',
    flightNo: ''
  };
  let flightUI; // UI容器

  // --- WebSocket ---
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
      const altitudeMSL = geofs?.animation?.values?.altitude;
      const groundElevationFeet = geofs?.animation?.values?.groundElevationFeet;
      const aircraft = geofs?.aircraft?.instance;

      if (
        typeof altitudeMSL === 'number' &&
        typeof groundElevationFeet === 'number' &&
        aircraft?.collisionPoints?.length >= 2 &&
        typeof aircraft.collisionPoints[aircraft.collisionPoints.length - 2]?.worldPosition?.[2] === 'number'
      ) {
        const collisionZFeet = aircraft.collisionPoints[aircraft.collisionPoints.length - 2].worldPosition[2] * 3.2808399;
        return Math.round((altitudeMSL - groundElevationFeet) + collisionZFeet);
      }
    } catch (err) {
      console.warn('[ATC-Reporter] AGL calculation error:', err);
    }
    return null;
  }

  // --- 擷取位置與姿態 ---
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
      const speed = geofs?.animation?.values?.groundSpeed ?? inst?.groundSpeed ?? 0;

      return { lat, lon, altMSL, altAGL, heading, speed };
    } catch (e) {
      console.warn('[ATC-Reporter] readSnapshot error:', e);
      return null;
    }
  }

  // --- 組裝 payload ---
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
      speed: Math.round(snap.speed || 0),
      flightNo: flightInfo.flightNo,
      departure: flightInfo.departure,
      arrival: flightInfo.arrival
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

  // --- Toast 提示 ---
  function showToast(msg) {
    const toast = document.createElement('div');
    toast.textContent = msg;
    toast.style.position = 'fixed';
    toast.style.bottom = '20px';
    toast.style.right = '20px';
    toast.style.background = 'rgba(0,0,0,0.8)';
    toast.style.color = '#fff';
    toast.style.padding = '8px 12px';
    toast.style.borderRadius = '6px';
    toast.style.fontSize = '13px';
    toast.style.zIndex = 1000000;
    toast.style.opacity = '0';
    toast.style.transition = 'opacity 0.3s ease';
    document.body.appendChild(toast);
    requestAnimationFrame(() => { toast.style.opacity = '1'; });
    setTimeout(() => {
      toast.style.opacity = '0';
      setTimeout(() => toast.remove(), 300);
    }, 2000);
  }

  // --- UI 注入 ---
  function injectFlightUI() {
    flightUI = document.createElement('div');
    flightUI.id = 'flightInfoUI';
    flightUI.style.position = 'fixed';
    flightUI.style.bottom = '280px';
    flightUI.style.right = '6px';
    flightUI.style.background = 'rgba(0,0,0,0.6)';
    flightUI.style.padding = '8px';
    flightUI.style.borderRadius = '6px';
    flightUI.style.color = 'white';
    flightUI.style.fontSize = '12px';
    flightUI.style.zIndex = 999999;

    flightUI.innerHTML = `
      <div>Dep: <input id="depInput" style="width:60px"></div>
      <div>Arr: <input id="arrInput" style="width:60px"></div>
      <div>Flt#: <input id="fltInput" style="width:60px"></div>
      <button id="saveBtn">Save</button>
    `;

    document.body.appendChild(flightUI);

    document.getElementById('saveBtn').onclick = () => {
      flightInfo.departure = document.getElementById('depInput').value.trim();
      flightInfo.arrival = document.getElementById('arrInput').value.trim();
      flightInfo.flightNo = document.getElementById('fltInput').value.trim();
      showToast('Flight info saved!');
    };
  }
  injectFlightUI();

  // --- 按 W 切換 UI ---
  document.addEventListener('keydown', (e) => {
    if (e.key.toLowerCase() === 'w') {
      if (flightUI.style.display === 'none') {
        flightUI.style.display = 'block';
        showToast('Flight Info UI Shown');
      } else {
        flightUI.style.display = 'none';
        showToast('Flight Info UI Hidden');
      }
    }
  });
 })();
