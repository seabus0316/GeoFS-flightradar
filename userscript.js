// ==UserScript==
// @name         GeoFS-flightradar receiver
// @namespace    http://tampermonkey.net/
// @version      2.0.00
// @description  Always loads the latest GeoFS flightradar script from GitHub (edited by Nico Kaiser)
// @author       SeaBus
// @match        http://*/geofs.php*
// @match        https://*/geofs.php*
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  /*** VERSION ***/
    const CURRENT_VERSION = '2.0.00';



  /*** CONFIG ***/
  const WS_URL = 'wss://geofs-flightradar.duckdns.org/ws';
  const SEND_INTERVAL_MS = 500;

  // --- Global Variables ---
  let mainCallsign = "Unkown"; // Default Callsign at Start
  let flightInfo = { departure: '', arrival: '', flightNo: '', squawk: '' };
  let flightUI;
  let wasOnGround = true;
  let takeoffTimeUTC = '';

  // --- Fixed ID (only once per page load) ---
  const fixedId = Math.random().toString(36).substr(2, 9);

  // ===== Update Check =====
  const VERSION_JSON_URL = 'https://raw.githubusercontent.com/seabus0316/GeoFS-flightradar/main/version.json';
  const UPDATE_URL = 'https://raw.githubusercontent.com/seabus0316/GeoFS-flightradar/main/userscript.js';

  function showModal(msg, duration = null, updateBtnUrl = null) {
    if (document.getElementById("geofs-atc-modal")) return;
    let overlay = document.createElement("div");
    overlay.id = "geofs-atc-modal";
    overlay.style.cssText = `
      position:fixed;top:0;left:0;width:100vw;height:100vh;z-index:99999;
      background:rgba(24,32,48,0.45);display:flex;align-items:center;justify-content:center;
    `;
    let box = document.createElement("div");
    box.style.cssText = `
      background:linear-gradient(135deg,#232942 80%,#151a25 100%);
      color:#dbeaff;padding:30px 34px;border-radius:18px;box-shadow:0 6px 32px #000b;
      min-width:280px;max-width:90vw;display:flex;flex-direction:column;align-items:center;gap:14px;
      border:2.5px solid #3d6aff;font-size:1.15rem;letter-spacing:0.3px;
      text-align:center;animation:popIn .21s;
    `;
    let content = document.createElement("div");
    content.innerHTML = msg;
    box.appendChild(content);

    if (updateBtnUrl) {
      let updateBtn = document.createElement("a");
      updateBtn.textContent = "Update";
      updateBtn.href = updateBtnUrl;
      updateBtn.target = "_blank";
      updateBtn.style.cssText = `
        margin-top:6px;padding:8px 38px;font-size:1.05rem;background:#1e3f6e;
        color:#fff;border:1.5px solid #4eaaff;border-radius:7px;font-weight:bold;cursor:pointer;
        box-shadow:0 1px 8px #4eaaff30;transition:background .18s;display:inline-block;text-decoration:none;
      `;
      updateBtn.onmouseover = function(){this.style.background="#1552a1";}
      updateBtn.onmouseout = function(){this.style.background="#1e3f6e";}
      box.appendChild(updateBtn);
    }

    let okBtn = document.createElement("button");
    okBtn.textContent = "OK";
    okBtn.style.cssText = `
      margin-top:16px;padding:8px 38px;font-size:1.05rem;background:#222b3c;
      color:#b2cfff;border:1.5px solid #4eaaff;border-radius:7px;font-weight:bold;cursor:pointer;
      box-shadow:0 1px 8px #3d6aff30;transition:background .18s;
    `;
    okBtn.onclick = () => { document.body.removeChild(overlay); };
    box.appendChild(okBtn);

    overlay.appendChild(box);
    document.body.appendChild(overlay);

    if (duration) setTimeout(() => { if (document.body.contains(overlay)) document.body.removeChild(overlay); }, duration);

    overlay.tabIndex = -1; overlay.focus();
    overlay.onkeydown = (e) => {
      if (e.key === "Enter" || e.key === "Escape") {
        if (document.body.contains(overlay)) document.body.removeChild(overlay);
      }
    };

    if (!document.getElementById("geofs-atc-modal-anim")) {
      const style = document.createElement('style');
      style.id = "geofs-atc-modal-anim";
      style.textContent = `
        @keyframes popIn { from { transform:scale(0.85);opacity:0; } to { transform:scale(1);opacity:1; } }
      `;
      document.head.appendChild(style);
    }
  }

  // VERSION CHECK (ONLY VERSION NUMBER)
  (function checkUpdate() {
    fetch(VERSION_JSON_URL)
      .then(r => r.json())
      .then(data => {
        if (data.version && data.version !== CURRENT_VERSION) {
          showModal(
            `🚩 GeoFS flightradar receiver new version available (Current Version: ${CURRENT_VERSION} ; New Version: ${data.version})!<br>Please reinstall the latest userscript.js from GitHub.`,
            null,
            UPDATE_URL
          );
        }
      })
      .catch(() => {});
  })();

  // --- WebSocket ---
  let ws;
  function connect() {
    try {
      ws = new WebSocket(WS_URL);
      ws.addEventListener('open', () => {
        console.log('[ATC-Reporter] WS connected');
        safeSend({ type: 'hello', role: 'player' });
      });
      ws.addEventListener('close', () => {
        console.log('[ATC-Reporter] WS closed, retrying...');
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
    try { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); }
    catch (e) { console.warn('[ATC-Reporter] send error', e); }
  }

  // --- Helpers ---
  function getAircraftName() {
    return geofs?.aircraft?.instance?.aircraftRecord?.name || 'Unknown';
  }

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
    } catch (err) { console.warn('[ATC-Reporter] AGL calculation error:', err); }
    return null;
  }

  function checkTakeoff() {
    const onGround = geofs?.aircraft?.instance?.groundContact ?? true;
    if (wasOnGround && !onGround) takeoffTimeUTC = new Date().toISOString();
    wasOnGround = onGround;
  }

  function readSnapshot() {
    try {
      const inst = geofs?.aircraft?.instance;
      if (!inst) return null;

      const lla = inst.llaLocation || [];
      const lat = lla[0], lon = lla[1], altMeters = lla[2];

      if (typeof lat !== 'number' || typeof lon !== 'number') return null;

      const altMSL = (typeof altMeters === 'number') ? altMeters * 3.28084 : geofs?.animation?.values?.altitude ?? 0;
      const altAGL = calculateAGL();
      const heading = geofs?.animation?.values?.heading360 ?? 0;
      const speed = geofs.animation.values.kias ? geofs.animation.values.kias.toFixed(1) : 0;

      return { lat, lon, altMSL, altAGL, heading, speed };
    } catch (e) { console.warn('[ATC-Reporter] readSnapshot error:', e); return null; }
  }

  function buildPayload(snap) {
    checkTakeoff();
    let flightPlan = [];
    try { if (geofs.flightPlan?.export) flightPlan = geofs.flightPlan.export(); } catch {}

    // --- Callsign --- use Foo if null or empty
    const ingame = geofs?.userRecord?.callsign || "Foo";
    const callsign = (mainCallsign || "Foo") + " (" + ingame + ")";

    return {
      id: fixedId,
      callsign: callsign,
      type: getAircraftName(),
      lat: snap.lat,
      lon: snap.lon,
      alt: typeof snap.altAGL === "number" ? snap.altAGL : Math.round(snap.altMSL || 0),
      altMSL: Math.round(snap.altMSL || 0),
      heading: Math.round(snap.heading || 0),
      speed: Math.round(snap.speed || 0),
      flightNo: flightInfo.flightNo,
      departure: flightInfo.departure,
      arrival: flightInfo.arrival,
      takeoffTime: takeoffTimeUTC,
      squawk: flightInfo.squawk,
      flightPlan,
      nextWaypoint: geofs.flightPlan?.trackedWaypoint?.ident || null,
      userId: geofs?.userRecord?.id || null
    };
  }

  // --- Send Loop ---
  setInterval(() => {
    if (!ws || ws.readyState !== 1) return;
    const snap = readSnapshot();
    if (!snap) return;
    safeSend({ type: 'position_update', payload: buildPayload(snap) });
  }, SEND_INTERVAL_MS);

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
    setTimeout(() => { toast.style.opacity = '0'; setTimeout(() => toast.remove(), 300); }, 2000);
  }

  // --- Flight UI ---
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
      <div>CS: <input id="csInput" style="width:60px" value="KLM"></div>
      <div>Dep: <input id="depInput" style="width:60px"></div>
      <div>Arr: <input id="arrInput" style="width:60px"></div>
      <div>Flt#: <input id="fltInput" style="width:60px"></div>
      <div>SQK: <input id="sqkInput" style="width:60px" maxlength="4"></div>
      <button id="saveBtn">Save</button>
    `;
    document.body.appendChild(flightUI);

    ["csInput","depInput","arrInput","fltInput","sqkInput"].forEach(id => {
      const el = document.getElementById(id);
      el.addEventListener("input", () => { el.value = el.value.toUpperCase(); });
    });

    document.getElementById("csInput").addEventListener("input", () => {
      mainCallsign = document.getElementById("csInput").value.trim().toUpperCase();
      showToast("Callsign = " + mainCallsign);
    });

    document.getElementById('saveBtn').onclick = () => {
      flightInfo.departure = document.getElementById('depInput').value.trim();
      flightInfo.arrival = document.getElementById('arrInput').value.trim();
      flightInfo.flightNo = document.getElementById('fltInput').value.trim();
      flightInfo.squawk = document.getElementById('sqkInput').value.trim();
      showToast('Flight info saved!');
    };
  }
  injectFlightUI();

  // --- Toggle UI ---
  document.addEventListener('keydown', (e) => {
    if (e.key.toLowerCase() === 'w') {
      flightUI.style.display = flightUI.style.display === 'none' ? 'block' : 'none';
      showToast(flightUI.style.display === 'none' ? 'UI Hidden' : 'UI Shown');
    }
  });

  // --- Prevent hotkeys while typing ---
  document.addEventListener("keydown", (e) => {
    if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") e.stopPropagation();
  }, true);

})();
