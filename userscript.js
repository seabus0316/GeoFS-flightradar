// IF YOU DON'T WANT UPDATE REMINDER DELETE HEADER

// ==UserScript==
// @name         GeoFS-flightradar receiver
// @namespace    http://tampermonkey.net/
// @version      1.9.80
// @description  Always loads the latest GeoFS flightradar script (edited by Nico Kaiser)
// @author       SeaBus
// @match        http://*/geofs.php*
// @match        https://*/geofs.php*
// @grant        GM_xmlhttpRequest
// ==/UserScript==

(function () {
  "use strict";

  /*** CONFIG ***/
  const WS_URL = "wss://geofs-flightradar.duckdns.org/ws";
  const SEND_INTERVAL_MS = 500;

// ---- Fixed ID (only reset on page reload) ----
  const fixedId = Math.random().toString(36).substr(2, 9);

  // ---- State ----
  let mainCallsign = "NICO K. [CODE ADMIN]";
  let flightInfo = { departure: "", arrival: "", flightNo: "", squawk: "" };
  let flightUI;
  let wasOnGround = true;
  let takeoffTimeUTC = "";

  // ========== Update Modal ==========
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
        padding:8px 38px;font-size:1.05rem;background:#1e3f6e;
        color:#fff;border-radius:7px;border:1.5px solid #4eaaff;
        cursor:pointer;text-decoration:none;
      `;
      box.appendChild(btn);
    }

    let okBtn = document.createElement("button");
    okBtn.textContent = "OK";
    okBtn.style.cssText = `
        padding:8px 38px;font-size:1.05rem;background:#222b3c;
        color:#b2cfff;border-radius:7px;border:1.5px solid #4eaaff;
        cursor:pointer;
    `;
    okBtn.onclick = () => overlay.remove();
    box.appendChild(okBtn);

    overlay.appendChild(box);
    document.body.appendChild(overlay);

    if (duration) setTimeout(() => overlay.remove(), duration);
  }

// === Versioning ===
const CURRENT_VERSION = "2.0.00";
const USERSCRIPT_RAW_URL = "https://raw.githubusercontent.com/seabus0316/GeoFS-flightradar/main/userscript.js";
const UPDATE_URL = "https://github.com/seabus0316/GeoFS-flightradar/raw/main/userscript.js";

function checkUpdate() {
  if (typeof GM_xmlhttpRequest !== "function") {
    console.warn("[GeoFS LivePosition] GM_xmlhttpRequest not available. Update check skipped.");
    return;
  }

  GM_xmlhttpRequest({
    method: "GET",
    url: USERSCRIPT_RAW_URL,
    onload: function (response) {
      if (response.status >= 200 && response.status < 300) {
        const txt = response.responseText;
        const match = txt.match(/@version\s+([0-9.]+)/);
        const remoteVersion = match ? match[1] : null;

        console.log("[GeoFS LivePosition] Local version:", CURRENT_VERSION, "Remote version:", remoteVersion);

        if (remoteVersion && remoteVersion !== CURRENT_VERSION) {
          showModal(
            `🚩 New version available!<br>Current: ${CURRENT_VERSION}<br>New: ${remoteVersion}`,
            null,
            UPDATE_URL
          );
        }
      } else {
        console.warn("[GeoFS LivePosition] Error fetching userscript for update check:", response.status);
      }
    },
    onerror: function (err) {
      console.warn("[GeoFS LivePosition] Error loading update info:", err);
    },
  });
}

checkUpdate();

  // ========== WebSocket ==========
  let ws;
  function connect() {
    ws = new WebSocket(WS_URL);

    ws.addEventListener("open", () => {
      console.log("[ATC-Reporter] WebSocket connected");
      safeSend({ type: "hello", role: "player" });
    });

    ws.addEventListener("close", () => {
      console.log("[ATC-Reporter] WS closed, retrying...");
      setTimeout(connect, 2000);
    });

    ws.addEventListener("error", () => {
      console.log("[ATC-Reporter] WS error");
      try { ws.close(); } catch {}
    });
  }
  connect();

  function safeSend(obj) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
  }

  // ========== Helpers ==========
  function getAircraftName() {
    return geofs?.aircraft?.instance?.aircraftRecord?.name || "Unknown";
  }

  function calculateAGL() {
    try {
      const altitudeMSL = geofs?.animation?.values?.altitude;
      const groundElevationFeet = geofs?.animation?.values?.groundElevationFeet;
      const aircraft = geofs?.aircraft?.instance;
      if (!aircraft?.collisionPoints?.length) return null;
      const cp = aircraft.collisionPoints[aircraft.collisionPoints.length - 2];
      if (!cp?.worldPosition) return null;
      const collisionFeet = cp.worldPosition[2] * 3.28084;
      return Math.round((altitudeMSL - groundElevationFeet) + collisionFeet);
    } catch {
      return null;
    }
  }

  function checkTakeoff() {
    const onGround = geofs?.aircraft?.instance?.groundContact ?? true;
    if (wasOnGround && !onGround) takeoffTimeUTC = new Date().toISOString();
    wasOnGround = onGround;
  }

  function readSnapshot() {
    const inst = geofs?.aircraft?.instance;
    if (!inst) return null;
    const lla = inst.llaLocation || [];
    const lat = lla[0], lon = lla[1], altM = lla[2];
    if (typeof lat !== "number" || typeof lon !== "number") return null;
    const altMSL = altM * 3.28084;
    const altAGL = calculateAGL();
    const heading = geofs?.animation?.values?.heading360 || 0;
    const speed = geofs?.animation?.values?.kias || 0;
    return { lat, lon, altMSL, altAGL, heading, speed };
  }

  function buildPayload(s) {
    checkTakeoff();
    let flightPlan = [];
    try { if (geofs.flightPlan?.export) flightPlan = geofs.flightPlan.export(); } catch {}
    const ingame = geofs?.userRecord?.callsign || "Foo";
    const callsign = (mainCallsign || "Foo") + " (" + ingame + ")";
    return {
      id: fixedId,
      callsign,
      type: getAircraftName(),
      lat: s.lat,
      lon: s.lon,
      alt: typeof s.altAGL === "number" ? s.altAGL : Math.round(s.altMSL),
      altMSL: Math.round(s.altMSL),
      heading: Math.round(s.heading),
      speed: Math.round(s.speed),
      flightNo: flightInfo.flightNo,
      departure: flightInfo.departure,
      arrival: flightInfo.arrival,
      squawk: flightInfo.squawk,
      takeoffTime: takeoffTimeUTC,
      flightPlan,
      nextWaypoint: geofs.flightPlan?.trackedWaypoint?.ident || null,
      userId: geofs?.userRecord?.id || null,
    };
  }

  // ========== SEND LOOP ==========
  setInterval(() => {
    const snap = readSnapshot();
    if (!snap || !ws || ws.readyState !== 1) return;
    safeSend({ type: "position_update", payload: buildPayload(snap) });
  }, SEND_INTERVAL_MS);

  // ========== Toast ==========
  function showToast(msg) {
    const t = document.createElement("div");
    t.textContent = msg;
    t.style = `
      position:fixed;bottom:20px;right:20px;background:rgba(0,0,0,0.8);
      color:white;padding:8px 12px;border-radius:6px;font-size:13px;
      opacity:0;transition:opacity .3s;z-index:999999;
    `;
    document.body.appendChild(t);
    requestAnimationFrame(() => t.style.opacity = "1");
    setTimeout(() => { t.style.opacity = "0"; setTimeout(() => t.remove(), 300); }, 1800);
  }

  // ========== Flight UI ==========
  function injectUI() {
    flightUI = document.createElement("div");
    flightUI.style = `
      position:fixed;right:6px;bottom:280px;background:rgba(0,0,0,0.6);
      padding:8px;border-radius:6px;color:white;font-size:12px;z-index:999999;
    `;
    flightUI.innerHTML = `
      <div>CS: <input id="csInput" value="KLM" style="width:60px"></div>
      <div>Dep: <input id="depInput" style="width:60px"></div>
      <div>Arr: <input id="arrInput" style="width:60px"></div>
      <div>Flt#: <input id="fltInput" style="width:60px"></div>
      <div>SQK: <input id="sqkInput" maxlength="4" style="width:60px"></div>
      <button id="saveBtn">Save</button>
    `;
    document.body.appendChild(flightUI);

    ["csInput","depInput","arrInput","fltInput","sqkInput"].forEach(id => {
      document.getElementById(id).addEventListener("input", e => { e.target.value = e.target.value.toUpperCase(); });
    });

    document.getElementById("csInput").addEventListener("input", () => {
      mainCallsign = document.getElementById("csInput").value.trim().toUpperCase();
      showToast("Callsign = " + mainCallsign);
    });

    document.getElementById("saveBtn").onclick = () => {
      flightInfo.departure = depInput.value.trim();
      flightInfo.arrival = arrInput.value.trim();
      flightInfo.flightNo = fltInput.value.trim();
      flightInfo.squawk = sqkInput.value.trim();
      showToast("Flight info saved");
    };
  }
  injectUI();

  // Toggle UI (W)
  document.addEventListener("keydown", (e) => {
    if (e.key.toLowerCase() === "w") {
      flightUI.style.display = flightUI.style.display === "none" ? "block" : "none";
      showToast(flightUI.style.display === "none" ? "UI Hidden" : "UI Shown");
    }
  });

  // Prevent keybinds in input
  document.addEventListener("keydown", (e) => {
    if (e.target.tagName === "INPUT") e.stopPropagation();
  }, true);

})();
