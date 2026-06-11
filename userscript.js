(function () {
  'use strict';

  /*** CONFIG ***/
  const WS_URL = 'wss://geofs-flightradar.duckdns.org/ws';
  const SEND_INTERVAL_MS = 1500;
  /*************/

  let loggedSpeedMode = false;
  let loggedPayloadSpeed = false;

    // ===== 新增 Modal 函數 =====
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

    if (duration) setTimeout(() => {
      if (document.body.contains(overlay)) document.body.removeChild(overlay);
    }, duration);

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

  function log(...args) {
    console.log('[ATC-Reporter]', ...args);
  }

  function readGeoFSAirspeedKnots() {
    const kias = geofs?.animation?.values?.kias;
    return typeof kias === 'number' && Number.isFinite(kias) ? kias : null;
  }

  function readFiniteNumber(...values) {
    for (const value of values) {
      if (typeof value === 'number' && Number.isFinite(value)) return value;
    }
    return null;
  }

  function vectorMagnitude(vector) {
    if (!Array.isArray(vector) || vector.length < 2) return null;
    const x = Number(vector[0]);
    const y = Number(vector[1]);
    const z = Number(vector[2] || 0);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null;
    return Math.sqrt(x * x + y * y + z * z);
  }

  function readGeoFSGroundSpeed(inst = geofs?.aircraft?.instance) {
    const metersPerSecond = readFiniteNumber(
      inst?.groundSpeed,
      inst?.velocityScalar,
      vectorMagnitude(inst?.velocity)
    );

    return metersPerSecond === null
      ? null
      : {
        knots: metersPerSecond * 1.94384,
        raw: metersPerSecond,
        source: inst?.groundSpeed !== undefined ? 'groundSpeed' : inst?.velocityScalar !== undefined ? 'velocityScalar' : 'velocity'
      };
  }

  function readGeoFSVersionString() {
    const candidates = [
      geofs?.version,
      geofs?.VERSION,
      geofs?.release,
      geofs?.api?.version,
      geofs?.preferences?.version,
      window?.geofsVersion,
      window?.GeoFSVersion,
      window?.GEofsVersion,
      window?.GEoFSVersion
    ];

    for (const value of candidates) {
      if (typeof value === 'string' && value.trim()) return value.trim();
      if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    }

    return '';
  }

  function getGeoFSMajorMinorVersion() {
    const version = readGeoFSVersionString();
    const match = version.match(/(\d+)\.(\d+)/);
    return match ? `${match[1]}.${match[2]}` : '';
  }

  function shouldUseLegacyKiasSpeed() {
    return getGeoFSMajorMinorVersion() === '3.9';
  }

  function readReportedSpeed(inst = geofs?.aircraft?.instance) {
    const legacyKias = shouldUseLegacyKiasSpeed();
    const groundSpeed = legacyKias ? null : readGeoFSGroundSpeed(inst);
    const airspeed = readGeoFSAirspeedKnots();
    const speedType = groundSpeed ? 'ground' : 'air';

    if (!loggedSpeedMode) {
      log('Speed mode:', legacyKias ? 'GeoFS 3.9 legacy speed' : `GeoFS 4.x ${speedType} speed`, {
        geofsVersion: readGeoFSVersionString(),
        geofsMajorMinor: getGeoFSMajorMinorVersion(),
        groundSpeedRaw: groundSpeed?.raw ?? null,
        groundSpeedKnots: groundSpeed?.knots ?? null,
        groundSpeedSource: groundSpeed?.source ?? null,
        airspeedKnots: airspeed
      });
      loggedSpeedMode = true;
    }

    return {
      knots: groundSpeed?.knots ?? airspeed ?? 0,
      type: speedType,
      source: groundSpeed?.source || 'kias',
      unit: 'kt',
      raw: groundSpeed?.raw ?? airspeed ?? 0
    };
  }

  // --- 全域變數 ---
window.geofsFlightInfo = {
  departure: '',
  arrival: '',
  originalArrival: '',
  actualArrival: '',
  flightNo: '',
  squawk: '',
  confirmed: false,
  isDiverted: false
};
let flightInfo = window.geofsFlightInfo;
  let flightUI;
  let wasOnGround = true;
  let takeoffTimeUTC = '';

  // --- 著陸偵測變數 ---
  let landingDetected = false;        // 防止同一次落地重複觸發
  let preLandingVertSpeed = 0;        // 觸地前最後一個 VS 取樣（fpm）
  let preLandingGroundSpeed = 0;      // 觸地前地速（kts）
  let preLandingGForce = 1.0;         // 觸地前 G 力
  let preLandingRoll = 0;             // 觸地前坡度
  // --- WebSocket & Socket.IO 管理 ---
  let ws;
  let isSocketIO = window.geofsFlightRadarConfig && window.geofsFlightRadarConfig.mode === 'socket.io';

  async function connect() {
    if (isSocketIO && window.GeoFSSocketIO) {
      log('Connecting using Socket.IO...');
      ws = await window.GeoFSSocketIO.initSocketIOConnection(WS_URL);
      if (!ws) {
        log('Socket.IO init failed, falling back to WebSocket');
        isSocketIO = false;
        connectWebSocket();
        return;
      }
      ws.on('connect', () => {
        log('Socket.IO connected');
        safeSend({ type: 'hello', role: 'player' });
      });
      ws.on('disconnect', () => {
        log('Socket.IO disconnected, it will auto-reconnect...');
      });
      ws.on('connect_error', (e) => {
        console.warn('[ATC-Reporter] Socket.IO error', e);
      });
    } else {
      connectWebSocket();
    }
  }

  function connectWebSocket() {
    try {
      ws = new WebSocket(WS_URL);
      ws.addEventListener('open', () => {
        log('WS connected');
        safeSend({ type: 'hello', role: 'player' });
      });
      ws.addEventListener('close', () => {
        log('WS closed, retrying...');
        setTimeout(connectWebSocket, 2000);
      });
      ws.addEventListener('error', (e) => {
        console.warn('[ATC-Reporter] WS error', e);
        try { ws.close(); } catch {}
      });
    } catch (e) {
      console.warn('[ATC-Reporter] WS connect error', e);
      setTimeout(connectWebSocket, 2000);
    }
  }
  
  connect();

  function safeSend(obj) {
    try {
      if (isSocketIO) {
        if (ws && ws.connected) {
          if (obj.type === 'position_update' || obj.type === 'landing_report') {
            ws.emit(obj.type, obj.payload);
          } else {
            ws.emit(obj.type, obj);
          }
        }
      } else {
        if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
      }
    } catch (e) {
      console.warn('[ATC-Reporter] send error', e);
    }
  }

  function getExportedFlightPlan() {
    function looksLikeWaypoint(value) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
      return (
        typeof value.ident === 'string' ||
        typeof value.name === 'string' ||
        typeof value.icao === 'string' ||
        typeof value.iata === 'string' ||
        typeof value.airport === 'string' ||
        typeof value.code === 'string' ||
        typeof value.label === 'string' ||
        (typeof value.lat === 'number' && typeof value.lon === 'number')
      );
    }

    function findWaypointArray(root) {
      const queue = [root];
      const seen = new Set();
      let inspected = 0;

      while (queue.length && inspected < 200) {
        const current = queue.shift();
        if (!current || typeof current !== 'object' || seen.has(current)) continue;
        seen.add(current);
        inspected += 1;

        if (Array.isArray(current)) {
          if (current.length && current.some(looksLikeWaypoint)) {
            return current;
          }
          for (const item of current) {
            if (item && typeof item === 'object') queue.push(item);
          }
          continue;
        }

        for (const value of Object.values(current)) {
          if (!value) continue;
          if (Array.isArray(value)) {
            if (value.length && value.some(looksLikeWaypoint)) {
              return value;
            }
            queue.push(value);
            continue;
          }
          if (typeof value === 'object') {
            queue.push(value);
          }
        }
      }

      return [];
    }

    try {
      const flightPlan = geofs?.flightPlan;
      if (!flightPlan) return [];

      if (typeof flightPlan.export === 'function') {
        const exported = flightPlan.export();
        if (Array.isArray(exported)) return exported;

        const exportedPlan = findWaypointArray(exported);
        if (exportedPlan.length) return exportedPlan;
      }

      const livePlan = findWaypointArray(flightPlan);
      if (livePlan.length) return livePlan;
    } catch (e) {}
    return [];
  }

  function extractWaypointLabel(waypoint) {
    if (!waypoint) return '';
    if (typeof waypoint === 'string') return waypoint.trim().toUpperCase();

    const candidates = [
      waypoint.ident,
      waypoint.name,
      waypoint.icao,
      waypoint.iata,
      waypoint.airport,
      waypoint.code
    ];

    for (const value of candidates) {
      if (typeof value === 'string' && value.trim()) {
        return value.trim().toUpperCase();
      }
    }

    return '';
  }

  function sanitizeWaypoint(waypoint) {
    if (!waypoint) return null;
    if (typeof waypoint === 'string') {
      const label = waypoint.trim();
      return label ? { ident: label.toUpperCase() } : null;
    }
    if (typeof waypoint !== 'object') return null;

    const lat = Number(waypoint.lat ?? waypoint.latitude ?? waypoint.location?.[0]);
    const lon = Number(waypoint.lon ?? waypoint.lng ?? waypoint.longitude ?? waypoint.location?.[1]);

    const sanitized = {
      ident: extractWaypointLabel(waypoint) || undefined,
      name: typeof waypoint.name === 'string' && waypoint.name.trim() ? waypoint.name.trim() : undefined,
      lat: Number.isFinite(lat) ? lat : undefined,
      lon: Number.isFinite(lon) ? lon : undefined
    };

    if (!sanitized.ident && !sanitized.name && sanitized.lat === undefined && sanitized.lon === undefined) {
      return null;
    }

    return sanitized;
  }

  function sanitizeFlightPlan(plan) {
    if (!Array.isArray(plan)) return [];
    return plan.map(sanitizeWaypoint).filter(Boolean);
  }

  // --- 工具函式 ---
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

  // --- 著陸品質分類 ---
  // Butter: VS > -30 fpm（比 landing_stats 更嚴格，原為 -50）
  // Great:  -30 ~ -200 fpm
  // Acceptable: -200 ~ -500 fpm
  // Hard:   -500 ~ -1000 fpm
  // Crash:  < -1000 fpm 或 VS > +200 fpm
  function classifyLanding(vertSpeedFpm) {
    if (vertSpeedFpm > 200 || vertSpeedFpm < -1000) return 'CRASH';
    if (vertSpeedFpm >= -30)  return 'BUTTER';
    if (vertSpeedFpm >= -200) return 'GREAT';
    if (vertSpeedFpm >= -500) return 'ACCEPTABLE';
    return 'HARD LANDING';
  }

  function shouldReportLandingQuality() {
    return Boolean(
      flightInfo?.confirmed &&
      takeoffTimeUTC &&
      flightInfo.departure &&
      flightInfo.arrival
    );
  }

  // --- 著陸回報 ---
  function reportLanding(vertSpeedFpm, groundSpeedKts, gForce, rollDeg) {
    if (!shouldReportLandingQuality()) {
      log('Landing detected, but flight is not confirmed. Skipping landing quality report.');
      return;
    }

    const quality = classifyLanding(vertSpeedFpm);
    const landingTime = new Date().toISOString();
    log('Landing detected:', quality, { vertSpeedFpm, groundSpeedKts, gForce, rollDeg });

    safeSend({
      type: 'landing_report',
      payload: {
        callsign:      getPlayerCallsign(),
        flightNo:      flightInfo.flightNo,
        departure:     flightInfo.departure,
        arrival:       flightInfo.arrival,
        userId:        geofs?.userRecord?.id || null,
        landingTime,
        verticalSpeed: Math.round(vertSpeedFpm),
        groundSpeed:   Math.round(groundSpeedKts),
        gForce:        Math.round(gForce * 100) / 100,
        rollAngle:     Math.round(rollDeg * 10) / 10,
        flightConfirmed: true,
        landingQuality: quality
      }
    });
  }

  // --- 起飛 & 著陸偵測 ---
  function checkTakeoff() {
    const inst = geofs?.aircraft?.instance;
    const onGround = inst?.groundContact ?? geofs?.animation?.values?.groundContact ?? true;

    // 空中時持續更新著陸前快照（每次 position tick 都取）
    if (!onGround) {
      const vs = geofs?.animation?.values?.verticalSpeed ?? 0;     // fpm
      const gs = geofs?.animation?.values?.groundSpeedKnt ?? 0;   // kts
      const gz = geofs?.animation?.values?.accZ ?? 9.80665;
      const roll = Math.abs(geofs?.animation?.values?.aroll ?? 0);
      preLandingVertSpeed   = vs;
      preLandingGroundSpeed = gs;
      preLandingGForce      = gz / 9.80665;
      preLandingRoll        = roll;
      landingDetected = false;  // 離地後重置，允許下次落地觸發
    }

    // 起飛偵測
    if (wasOnGround && !onGround) {
      takeoffTimeUTC = new Date().toISOString();
      console.log('[ATC-Reporter] Takeoff at', takeoffTimeUTC);
    }

    // 著陸偵測（地面接觸瞬間，且尚未回報過）
    if (!wasOnGround && onGround && !landingDetected) {
      landingDetected = true;
      reportLanding(preLandingVertSpeed, preLandingGroundSpeed, preLandingGForce, preLandingRoll);
    }

    wasOnGround = onGround;
  }

  // --- 擷取飛行狀態 ---
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
      const speed = readReportedSpeed(inst);

      return { lat, lon, altMSL, altAGL, heading, speed };
    } catch (e) {
      console.warn('[ATC-Reporter] readSnapshot error:', e);
      return null;
    }
  }

  // --- 組裝 payload ----
function buildPayload(snap) {
  checkTakeoff();
  const flightPlan = sanitizeFlightPlan(getExportedFlightPlan());
 const userId = geofs?.userRecord?.id || null;
  return {
    id: getPlayerCallsign(),
    callsign: getPlayerCallsign(),
    type: getAircraftName(),
    lat: snap.lat,
    lon: snap.lon,
    alt: (typeof snap.altAGL === 'number') ? snap.altAGL : Math.round(snap.altMSL || 0),
    altMSL: Math.round(snap.altMSL || 0),
    heading: Math.round(snap.heading || 0),
    speed: Math.round(snap.speed?.knots || 0),
    speedType: snap.speed?.type || 'air',
    speedSource: snap.speed?.source || '',
    speedUnit: snap.speed?.unit || 'kt',
    speedRaw: Math.round((snap.speed?.raw || 0) * 10) / 10,
    geofsVersion: readGeoFSVersionString(),
    geofsMajorMinor: getGeoFSMajorMinorVersion(),
    flightNo: flightInfo.flightNo,
    departure: flightInfo.departure,
    arrival: flightInfo.arrival,
    originalArrival: flightInfo.originalArrival || flightInfo.arrival,
    actualArrival: flightInfo.actualArrival || flightInfo.arrival,
    isDiverted: Boolean(flightInfo.isDiverted),
    takeoffTime: takeoffTimeUTC,
    squawk: flightInfo.squawk,
    flightConfirmed: Boolean(flightInfo.confirmed),
    flightPlan: flightPlan,
    nextWaypoint: geofs.flightPlan?.trackedWaypoint?.ident || null,  // ← 加這行
    userId: userId  // ← 添加這行
  };
}

  // --- 定期傳送 ---
  setInterval(() => {
    if (isSocketIO) {
      if (!ws || !ws.connected) return;
    } else {
      if (!ws || ws.readyState !== 1) return;
    }
    const snap = readSnapshot();
    if (!snap) return;
    const payload = buildPayload(snap);
    if (!loggedPayloadSpeed) {
      log('Position payload speed:', {
        speed: payload.speed,
        speedType: payload.speedType,
        speedSource: payload.speedSource,
        speedUnit: payload.speedUnit,
        speedRaw: payload.speedRaw,
        geofsMajorMinor: payload.geofsMajorMinor
      });
      loggedPayloadSpeed = true;
    }
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
  function createFetchPlanIcon() {
    return `
      <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" focusable="false">
        <path fill="currentColor" d="M6 4.75A2.75 2.75 0 0 1 8.75 2h6.5A2.75 2.75 0 0 1 18 4.75v10.5A2.75 2.75 0 0 1 15.25 18H14v1.05a.95.95 0 0 1-1.62.67l-2.08-2.09A1 1 0 0 1 10 16.93V18H8.75A2.75 2.75 0 0 1 6 15.25Zm2.75-1.25c-.69 0-1.25.56-1.25 1.25v10.5c0 .69.56 1.25 1.25 1.25H10v-.57a.95.95 0 0 1 1.62-.67L13 16.64V16.5h2.25c.69 0 1.25-.56 1.25-1.25V4.75c0-.69-.56-1.25-1.25-1.25Zm.75 3a.75.75 0 0 1 .75-.75h4.5a.75.75 0 0 1 0 1.5h-4.5a.75.75 0 0 1-.75-.75Zm0 3a.75.75 0 0 1 .75-.75h3a.75.75 0 0 1 0 1.5h-3a.75.75 0 0 1-.75-.75Zm8.78 9.03a.75.75 0 0 1-1.06 0l-.97-.97V21a.75.75 0 0 1-1.5 0v-3.44l-.97.97a.75.75 0 1 1-1.06-1.06l2.25-2.25a.75.75 0 0 1 1.06 0l2.25 2.25a.75.75 0 0 1 0 1.06Z"/>
      </svg>
    `;
  }

  function createDivertIcon() {
    return `
      <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" focusable="false">
        <path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M4 18h4c4.5 0 6.5-3 8.5-8.5"/>
        <path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M4 6h4c2.5 0 4.2 1 5.6 3"/>
        <path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M14 4h6v6"/>
        <path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M16 14h6v6"/>
      </svg>
    `;
  }

  function injectFlightUI() {
    flightUI = document.createElement("div");
    flightUI.style.cssText =
      "position:fixed;bottom:280px;right:6px;background:rgba(0,0,0,0.6);padding:8px;border-radius:6px;color:white;font-size:12px;z-index:999999";

    flightUI.innerHTML = `
      <div>Dep <input id="depInput" style="width:60px"></div>
      <div>Arr <input id="arrInput" style="width:60px"></div>
      <div>Flt <input id="fltInput" style="width:60px"></div>
      <div>SQK <input id="sqkInput" style="width:60px"></div>
      <div style="display:flex;align-items:center;gap:4px;margin-top:4px">
        <button id="fetchPlanBtn" type="button" title="Fetch departure and arrival from the first and last flight plan waypoint" aria-label="Fetch departure and arrival from flight plan" style="display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;padding:0;border:1px solid #4eaaff;border-radius:6px;background:#1e3f6e;color:#d7ecff;cursor:pointer">${createFetchPlanIcon()}</button>
        <button id="saveBtn">Save</button>
        <button id="divertBtn" type="button" title="Mark current arrival as diversion" aria-label="Mark current arrival as diversion" style="display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;padding:0;border:1px solid #ff6b5f;border-radius:6px;background:#5c1d1a;color:#ffd8d3;cursor:pointer">${createDivertIcon()}</button>
      </div>
    `;

    document.body.appendChild(flightUI);

    [depInput, arrInput, fltInput, sqkInput].forEach((input) => {
      input.style.textTransform = 'uppercase';
      input.addEventListener('input', () => {
        input.value = input.value.toUpperCase();
        flightInfo.confirmed = false;
      });
    });

    fetchPlanBtn.addEventListener('mouseenter', () => {
      fetchPlanBtn.style.background = '#1552a1';
    });
    fetchPlanBtn.addEventListener('mouseleave', () => {
      fetchPlanBtn.style.background = '#1e3f6e';
    });

    divertBtn.addEventListener('mouseenter', () => {
      divertBtn.style.background = '#7a2824';
    });
    divertBtn.addEventListener('mouseleave', () => {
      divertBtn.style.background = '#5c1d1a';
    });

    fetchPlanBtn.onclick = () => {
      const plan = getExportedFlightPlan();
      if (plan.length < 2) {
        console.log('[ATC-Reporter] geofs.flightPlan debug:', geofs?.flightPlan);
        showToast('Flight plan needs at least 2 waypoints');
        return;
      }

      const departure = extractWaypointLabel(plan[0]);
      const arrival = extractWaypointLabel(plan[plan.length - 1]);

      if (!departure || !arrival) {
        showToast('Unable to read first/last waypoint');
        return;
      }

      depInput.value = departure;
      arrInput.value = arrival;
      flightInfo.confirmed = false;
      showToast(`Fetched ${departure} -> ${arrival}`);
    };

    saveBtn.onclick = () => {
      flightInfo.departure = depInput.value.trim();
      flightInfo.arrival = arrInput.value.trim();
      flightInfo.originalArrival = flightInfo.arrival;
      flightInfo.actualArrival = flightInfo.arrival;
      flightInfo.flightNo = fltInput.value.trim();
      flightInfo.squawk = sqkInput.value.trim();
      flightInfo.confirmed = Boolean(flightInfo.departure && flightInfo.arrival);
      flightInfo.isDiverted = false;
      showToast(flightInfo.confirmed ? 'Flight Info Saved' : 'Flight info incomplete');
    };

    divertBtn.onclick = () => {
      const newArrival = arrInput.value.trim();
      const originalArrival = flightInfo.originalArrival || flightInfo.arrival;

      if (!flightInfo.confirmed || !originalArrival) {
        showToast('Save original flight first');
        return;
      }
      if (!newArrival) {
        showToast('Arrival airport required');
        return;
      }
      if (newArrival === originalArrival) {
        showToast('Arrival unchanged');
        return;
      }

      flightInfo.actualArrival = newArrival;
      flightInfo.isDiverted = true;
      flightInfo.confirmed = Boolean(flightInfo.departure && flightInfo.arrival);
      showToast(`Diverting to ${newArrival}`);
    };
  }
  injectFlightUI();

  // --- 快捷鍵 W 收合 UI ---
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

  // --- 關閉所有 input 的 autocomplete ---
  document.querySelectorAll("input").forEach(el => {
    el.setAttribute("autocomplete", "off");
  });

  // --- 防止 input 觸發 GeoFS hotkey ---
  document.addEventListener("keydown", (e) => {
    const target = e.target;
    if (target.tagName === "INPUT" || target.tagName === "TEXTAREA") {
      e.stopPropagation();
    }
  }, true);

})();
