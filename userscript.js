// Header not in use (make a new File and put it in there)

// ==UserScript==
// @name         GeoFS-flightradar receiver
// @namespace    http://tampermonkey.net/
// @version      2.0.00
// @description  GeoFS flightradar receiver with automatic version-check
// @author       SeaBus
// @match        http://*/geofs.php*
// @match        https://*/geofs.php*
// @grant        none
// ==/UserScript==

(function () {
  "use strict";

  // ------------------------
  // DATA SET
  // ------------------------

  const CURRENT_VERSION = "2.0.00"; // Current Version
  const USERSCRIPT_URL = "https://raw.githubusercontent.com/seabus0316/GeoFS-flightradar/main/userscript.js";
  const UPDATE_URL   = "https://github.com/seabus0316/GeoFS-flightradar/raw/main/userscript.js";
  const WS_URL       = "wss://geofs-flightradar.duckdns.org/ws";
  const SEND_INTERVAL_MS = 500;



  // ------------------------
  //  VERSION CHECK
  // ------------------------

  (async function versionCheck() {
    const remoteVersion = await getRemoteVersion();

    if (!remoteVersion) return;

    if (CURRENT_VERSION !== remoteVersion) {
      showModal(
        `🚩 New version available!<br>` +
        `Current Version: ${CURRENT_VERSION}<br>` +
        `New Version: ${remoteVersion}`,
        null,
        UPDATE_URL
      );
    }
  })();

  async function getRemoteVersion() {
    try {
      const txt = await fetch(USERSCRIPT_URL).then(r => r.text());
      const match = txt.match(/CURRENT_VERSION\s*=\s*["']([0-9.]+)["']/);
      if (match) return match[1];
    } catch (e) {
      console.warn("[GeoFS-LivePosition] Version check failed.", e);
      showModal("Error loading update information.", 3500, null);
    }
    return null;
  }



  // ------------------------
  //   REST OF CODE
  // ------------------------



  function showModal(msg, duration = null, updateBtnUrl = null) {
    if (document.getElementById("geofs-atc-modal")) return;

    let overlay = document.createElement("div");
    overlay.id = "geofs-atc-modal";
    overlay.style.cssText = `
      position:fixed;top:0;left:0;width:100vw;height:100vh;
      z-index:99999;background:rgba(24,32,48,0.45);
      display:flex;align-items:center;justify-content:center;
    `;

    let box = document.createElement("div");
    box.style.cssText = `
      background:linear-gradient(135deg,#232942 80%,#151a25 100%);
      color:#dbeaff;padding:30px 34px;border-radius:18px;
      box-shadow:0 6px 32px #000b;min-width:280px;max-width:90vw;
      display:flex;flex-direction:column;align-items:center;gap:14px;
      border:2.5px solid #3d6aff;font-size:1.15rem;text-align:center;
    `;

    let content = document.createElement("div");
    content.innerHTML = msg;
    box.appendChild(content);

    if (updateBtnUrl) {
      let btn = document.createElement("a");
      btn.textContent = "Update";
      btn.href = updateBtnUrl;
      btn.target = "_blank";
      btn.style.cssText = `
        margin-top:6px;padding:8px 38px;font-size:1.05rem;
        background:#1e3f6e;color:#fff;border:1.5px solid #4eaaff;
        border-radius:7px;font-weight:bold;cursor:pointer;
        box-shadow:0 1px 8px #4eaaff30;
        text-decoration:none;
      `;
      box.appendChild(btn);
    }

    let okBtn = document.createElement("button");
    okBtn.textContent = "OK";
    okBtn.style.cssText = `
      margin-top:16px;padding:8px 38px;font-size:1.05rem;
      background:#222b3c;color:#b2cfff;
      border:1.5px solid #4eaaff;border-radius:7px;
      font-weight:bold;cursor:pointer;
    `;
    okBtn.onclick = () => overlay.remove();
    box.appendChild(okBtn);

    overlay.appendChild(box);
    document.body.appendChild(overlay);

    if (duration) setTimeout(() => overlay.remove(), duration);
  }



  let mainCallsign = "Unknown";
  const fixedId = Math.random().toString(36).substr(2,9);
  let flightInfo = { departure:'', arrival:'', flightNo:'', squawk:'' };
  let wasOnGround = true;
  let takeoffTimeUTC = '';

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
    try {
      if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
    } catch (e) {
      console.warn('[ATC-Reporter] send error', e);
    }
  }

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

      const altMSL = (typeof altMeters === 'number')
        ? altMeters * 3.28084
        : geofs?.animation?.values?.altitude ?? 0;

      const altAGL = calculateAGL();
      const heading = geofs?.animation?.values?.heading360 ?? 0;
      const speed = geofs.animation.values.kias || 0;

      return { lat, lon, altMSL, altAGL, heading, speed };

    } catch (e) {
      console.warn('[ATC-Reporter] readSnapshot error:', e);
      return null;
    }
  }

  function buildPayload(snap) {
    checkTakeoff();

    let flightPlan = [];
    try { if (geofs.flightPlan?.export) flightPlan = geofs.flightPlan.export(); } catch {}

    const ingame = geofs?.userRecord?.callsign || "Foo";
    const callsign = (mainCallsign || "Foo") + " (" + ingame + ")";

    return {
      id: fixedId,
      callsign,
      type: getAircraftName(),
      lat: snap.lat,
      lon: snap.lon,
      alt: typeof snap.altAGL === "number" ? snap.altAGL : Math.round(snap.altMSL),
      altMSL: Math.round(snap.altMSL),
      heading: Math.round(snap.heading),
      speed: Math.round(snap.speed),
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

  setInterval(() => {
    if (!ws || ws.readyState !== 1) return;

    const snap = readSnapshot();
    if (!snap) return;

    safeSend({ type: "position_update", payload: buildPayload(snap) });
  }, SEND_INTERVAL_MS);

  function showToast(msg) {
    const toast = document.createElement("div");
    toast.textContent = msg;
    toast.style = `
      position:fixed;bottom:20px;right:20px;
      background:rgba(0,0,0,0.8);color:#fff;
      padding:8px 12px;border-radius:6px;
      font-size:13px;z-index:999999;
      opacity:0;transition:opacity .3s;
    `;
    document.body.appendChild(toast);
    requestAnimationFrame(() => toast.style.opacity = "1");
    setTimeout(() => {
      toast.style.opacity = "0";
      setTimeout(() => toast.remove(), 300);
    }, 1800);
  }

  function injectUI() {
    flightUI = document.createElement("div");
    flightUI.style = `
      position:fixed;right:6px;bottom:280px;
      background:rgba(0,0,0,0.6);padding:8px;
      border-radius:6px;color:white;
      font-size:12px;z-index:999999;
    `;

    flightUI.innerHTML = `
      <div>CS:  <input id="csInput"  style="width:60px"></div>
      <div>Dep: <input id="depInput" style="width:60px"></div>
      <div>Arr: <input id="arrInput" style="width:60px"></div>
      <div>Flt#: <input id="fltInput" style="width:60px"></div>
      <div>SQK: <input id="sqkInput" maxlength="4" style="width:60px"></div>
      <button id="saveBtn">Save</button>
    `;

    document.body.appendChild(flightUI);

    ["csInput","depInput","arrInput","fltInput","sqkInput"].forEach(id => {
      document.getElementById(id).addEventListener("input", e => {
        e.target.value = e.target.value.toUpperCase();
      });
    });

    document.getElementById("csInput").addEventListener("input", () => {
      mainCallsign = document.getElementById("csInput").value.trim().toUpperCase();
      showToast("Callsign = " + mainCallsign);
    });

    document.getElementById("saveBtn").onclick = () => {
      flightInfo.departure = document.getElementById("depInput").value.trim();
      flightInfo.arrival = document.getElementById("arrInput").value.trim();
      flightInfo.flightNo = document.getElementById("fltInput").value.trim();
      flightInfo.squawk = document.getElementById("sqkInput").value.trim();
      showToast("Flight info saved!");
    };
  }

  injectUI();

  document.addEventListener('keydown', (e) => {
    if (e.key.toLowerCase() === 'w') {
      flightUI.style.display = flightUI.style.display === 'none'
        ? 'block'
        : 'none';
      showToast(flightUI.style.display === 'none' ? 'UI Hidden' : 'UI Shown');
    }
  });

  document.addEventListener("keydown", (e) => {
    if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA")
      e.stopPropagation();
  }, true);

})();
