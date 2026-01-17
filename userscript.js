// ==UserScript==
// @name         GeoFS Flightradar
// @namespace    http://tampermonkey.net/
// @version      4.0.0
// @description  Transmits GeoFS flight data to the radar server
// @author       JThweb
// @match        https://www.geo-fs.com/geofs.php*
// @match        https://geo-fs.com/geofs.php*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=geo-fs.com
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  /*** CONFIG ***/
  // If running server locally, use 'ws://localhost:6969/ws' (You may need to allow mixed content)
  // If using public server, use 'wss://radar.yugp.me/ws'
  const WS_URL = 'wss://radar.yugp.me/ws'; 
  const SEND_INTERVAL_MS = 1500;
  /*************/

    // ===== Modal Function =====
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
      background: rgba(22, 25, 32, 0.95);
      backdrop-filter: blur(16px);
      -webkit-backdrop-filter: blur(16px);
      color: #e9ecef;
      padding: 40px;
      border-radius: 24px;
      box-shadow: 0 20px 60px rgba(0,0,0,0.6);
      min-width: 360px;
      max-width: 90vw;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 20px;
      border: 1px solid rgba(255,255,255,0.1);
      font-family: 'Segoe UI', system-ui, sans-serif;
      text-align: center;
      animation: popIn 0.3s cubic-bezier(0.34, 1.56, 0.64, 1);
    `;
    let content = document.createElement("div");
    content.innerHTML = msg;
    content.style.fontSize = "1.2rem";
    content.style.lineHeight = "1.6";
    box.appendChild(content);

    if (updateBtnUrl) {
      let updateBtn = document.createElement("a");
      updateBtn.textContent = "Update Now";
      updateBtn.href = updateBtnUrl;
      updateBtn.target = "_blank";
      updateBtn.style.cssText = `
        margin-top: 10px;
        padding: 12px 32px;
        font-size: 1rem;
        background: linear-gradient(135deg, #4dabf7, #339af0);
        color: #fff;
        border: none;
        border-radius: 12px;
        font-weight: 600;
        cursor: pointer;
        box-shadow: 0 4px 12px rgba(51, 154, 240, 0.3);
        transition: transform 0.2s, box-shadow 0.2s;
        text-decoration: none;
        display: inline-block;
      `;
      updateBtn.onmouseover = function(){this.style.transform="translateY(-2px)";this.style.boxShadow="0 6px 16px rgba(51, 154, 240, 0.4)";}
      updateBtn.onmouseout = function(){this.style.transform="translateY(0)";this.style.boxShadow="0 4px 12px rgba(51, 154, 240, 0.3)";}
      box.appendChild(updateBtn);
    }

    let okBtn = document.createElement("button");
    okBtn.textContent = "Got it";
    okBtn.style.cssText = `
      margin-top: 10px;
      padding: 12px 40px;
      font-size: 1rem;
      background: rgba(255,255,255,0.1);
      color: #fff;
      border: 1px solid rgba(255,255,255,0.1);
      border-radius: 12px;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.2s;
    `;
    okBtn.onmouseover = function(){this.style.background="rgba(255,255,255,0.2)";}
    okBtn.onmouseout = function(){this.style.background="rgba(255,255,255,0.1)";}
    okBtn.onclick = () => { document.body.removeChild(overlay); };
    box.appendChild(okBtn);
    overlay.appendChild(box);
    document.body.appendChild(overlay);

    if (duration) setTimeout(() => {
      if (document.body.contains(overlay)) document.body.removeChild(overlay);
    }, duration);

    // Allow clicking outside the box to dismiss the modal
    overlay.onclick = (e) => {
      if (e.target === overlay) {
        if (document.body.contains(overlay)) document.body.removeChild(overlay);
      }
    };

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

  // --- Global Variables ---
  let flightInfo = { departure: '', arrival: '', flightNo: '', squawk: '', registration: '' };
  let isTransponderActive = localStorage.getItem('geofs_radar_transponder_active') === 'true';
  let prevAltMSL = null;
  let prevAltTs = null;
  
  // Load saved flight info
  try {
      const saved = localStorage.getItem('geofs_radar_flightinfo');
      if (saved) {
          const parsed = JSON.parse(saved);
          flightInfo = { ...flightInfo, ...parsed };
      }
  } catch(e) {}

  let flightUI;
  let wasOnGround = true;
  let takeoffTimeUTC = '';
  let actualDeparture = null;
  let actualArrival = null;

  // --- Airport Manager ---
  const AirportManager = {
    airports: [],
    airportByCode: new Map(),
    loaded: false,
    
    async load() {
      try {
        const res = await fetch('https://raw.githubusercontent.com/mwgg/Airports/master/airports.json');
        const data = await res.json();
        this.airports = Object.values(data);
        this.airportByCode = new Map();
        for (const apt of this.airports) {
          const icao = (apt?.icao || '').toString().trim().toUpperCase();
          const iata = (apt?.iata || '').toString().trim().toUpperCase();
          if (icao) this.airportByCode.set(icao, apt);
          // Prefer ICAO when both exist; only set IATA if unused
          if (iata && !this.airportByCode.has(iata)) this.airportByCode.set(iata, apt);
        }
        this.loaded = true;
        console.log('[ATC-Reporter] Airports loaded:', this.airports.length);
      } catch (e) {
        console.warn('[ATC-Reporter] Failed to load airports:', e);
      }
    },

    getNearest(lat, lon) {
      if (!this.loaded) return null;
      let minDst = Infinity;
      let nearest = null;
      
      for (const apt of this.airports) {
        const d = Math.sqrt(Math.pow(apt.lat - lat, 2) + Math.pow(apt.lon - lon, 2));
        if (d < minDst) {
          minDst = d;
          nearest = apt;
        }
      }
      
      // Threshold (e.g. 0.1 degrees ~ 10km)
      if (minDst < 0.1) return nearest;
      return null;
    }
  };
  
  AirportManager.load();

  // Cleanup: remove any stray fullscreen modal left by previous runs (prevents screen from being dark/blocked)
  function cleanupOverlays() {
    try {
      const stray = document.getElementById('geofs-atc-modal');
      if (stray && stray.parentElement) stray.parentElement.removeChild(stray);
    } catch (e) {}

    try {
      // Safety: remove any body direct children that are full-screen fixed overlays with high z-index
      document.querySelectorAll('body > *').forEach(el => {
        try {
          const cs = window.getComputedStyle(el);
          const isFixed = cs.position === 'fixed';
          const isFullscreen = (cs.top === '0px' && cs.left === '0px' && (cs.width === '100vw' || cs.width === '100%' || cs.width === window.innerWidth + 'px') && (cs.height === '100vh' || cs.height === '100%' || cs.height === window.innerHeight + 'px'));
          const z = parseInt(cs.zIndex || 0, 10) || 0;
          if (isFixed && isFullscreen && z >= 10000) {
            el.remove();
          }
        } catch (err) {}
      });
    } catch (e) {}

    try {
      // Ensure essential UI roots are visible if they were hidden accidentally
      const root = document.getElementById('react-root'); if (root) root.style.display = 'block';
      const mapEl = document.getElementById('map'); if (mapEl) mapEl.style.display = 'block';
      const cesiumEl = document.getElementById('cesiumContainer'); if (cesiumEl) cesiumEl.style.display = 'block';
    } catch (e) {}
  }

  // Run once and for the next 20 seconds to catch transient overlays shown on load or update checks
  cleanupOverlays();
  const overlayCleanupInterval = setInterval(cleanupOverlays, 2000);
  setTimeout(() => clearInterval(overlayCleanupInterval), 20000);

  // --- Flight Logger Integration ---
  const FlightLogger = {
    webhooks: {},
    airlineCodes: {},
    userInfo: null,
    flightStarted: false,
    flightStartTime: null,
    departureICAO: "UNKNOWN",
    arrivalICAO: "UNKNOWN",
    firstGroundContact: false,
    oldAGL: 0,
    newAGL: 0,
    calculatedVerticalSpeed: 0,
    oldTime: Date.now(),
    bounces: 0,
    isGrounded: true,
    justLanded: false,
    teleportWarnings: 0,
    lastPosition: null,
    lastPositionTime: null,
    
    async init() {
        try {
            const httpUrl = WS_URL.startsWith('wss://') ? WS_URL.replace('wss://', 'https://') : WS_URL.replace('ws://', 'http://');
            const res = await fetch(`${httpUrl}/api/webhooks`);
            this.webhooks = await res.json();
            console.log('[FlightLogger] Webhooks loaded:', Object.keys(this.webhooks).length);
        } catch (e) {
            console.warn('[FlightLogger] Failed to load webhooks:', e);
        }

        try {
            const httpUrl = WS_URL.startsWith('wss://') ? WS_URL.replace('wss://', 'https://') : WS_URL.replace('ws://', 'http://');
            const res = await fetch(`${httpUrl}/api/airline_codes`);
            this.airlineCodes = await res.json();
            console.log('[FlightLogger] Airline codes loaded:', Object.keys(this.airlineCodes).length);
        } catch (e) {
            console.warn('[FlightLogger] Failed to load airline codes:', e);
        }

        try {
            const httpUrl = WS_URL.startsWith('wss://') ? WS_URL.replace('wss://', 'https://') : WS_URL.replace('ws://', 'http://');
            const res = await fetch(`${httpUrl}/api/me`, { credentials: 'include' });
            if (res.ok) {
                this.userInfo = await res.json();
                console.log('[FlightLogger] User authenticated:', this.userInfo.username);
            }
        } catch (e) {
            console.warn('[FlightLogger] Failed to fetch user info:', e);
        }

        setInterval(() => this.monitor(), 1000);
        setInterval(() => this.updateCalVertS(), 25);
    },

    updateCalVertS() {
        if (typeof geofs === 'undefined' || !geofs.animation || !geofs.animation.values || geofs.isPaused()) return;
        
        const values = geofs.animation.values;
        const inst = geofs.aircraft?.instance;
        if (!inst || !inst.collisionPoints || inst.collisionPoints.length < 2) return;

        const alt = values.altitude;
        const ground = values.groundElevationFeet;
        if (alt === undefined || ground === undefined) return;

        const collisionZ = inst.collisionPoints[inst.collisionPoints.length - 2].worldPosition[2] * 3.2808399;
        const currentAGL = (alt - ground) + collisionZ;

        if (currentAGL !== this.oldAGL) {
            const newTime = Date.now();
            const timeDiff = newTime - this.oldTime;
            if (timeDiff > 0) {
                this.calculatedVerticalSpeed = (currentAGL - this.oldAGL) * (60000 / timeDiff);
                this.oldAGL = currentAGL;
                this.oldTime = newTime;
            }
        }
    },

    monitor() {
        if (typeof geofs === 'undefined' || !geofs.animation || !geofs.animation.values || !geofs.aircraft || !geofs.aircraft.instance) return;
        
        const values = geofs.animation.values;
        const onGround = values.groundContact;
        const altitudeFt = values.altitude * 3.28084;
        const [lat, lon] = geofs.aircraft.instance.llaLocation || [values.latitude, values.longitude];
        const now = Date.now();

        if (this.flightStarted && this.lastPosition) {
             const dist = this.calculateDistance(this.lastPosition.lat, this.lastPosition.lon, lat, lon);
             const timeDiff = (now - this.lastPositionTime) / 1000;
             if (timeDiff > 1 && dist > (timeDiff * 0.6) && Math.abs(altitudeFt - this.lastPosition.altitude) > (timeDiff * 200)) {
                 this.teleportWarnings++;
                 console.warn('[FlightLogger] Teleport detected!');
             }
        }
        this.lastPosition = { lat, lon, altitude: altitudeFt };
        this.lastPositionTime = now;

        const enhancedAGL = (values.altitude !== undefined && values.groundElevationFeet !== undefined) ?
          ((values.altitude - values.groundElevationFeet) +
           (geofs.aircraft.instance.collisionPoints[geofs.aircraft.instance.collisionPoints.length - 2].worldPosition[2] * 3.2808399))
          : 0;

        if (enhancedAGL < 500) {
          if (onGround && !this.isGrounded) {
              this.justLanded = true;
          }
          this.isGrounded = onGround;
        }

        if (!this.flightStarted && !onGround && enhancedAGL > 100) {
            this.flightStarted = true;
            this.flightStartTime = now;
            const apt = AirportManager.getNearest(lat, lon);
            this.departureICAO = apt ? (apt.icao || apt.iata || "UNKNOWN") : "UNKNOWN";
            this.teleportWarnings = 0;
            this.bounces = 0;
            this.firstGroundContact = false;
            console.log(`[FlightLogger] Flight started from ${this.departureICAO}`);
            if (typeof showToast === 'function') showToast(`Flight Started from ${this.departureICAO}`);
        }

        const elapsed = (now - this.flightStartTime) / 1000;
        
        // Landing Detection
        if (this.flightStarted && onGround && enhancedAGL <= 50) {
             // Check for Teleportation (prevent false landing log)
             if (this.teleportWarnings > 0) {
                 console.log('[FlightLogger] Teleport detected on arrival - resetting flight without logging.');
                 this.flightStarted = false;
                 this.teleportWarnings = 0;
                 return;
             }

             // Check if we have been flying for at least 30 seconds to avoid taxi false positives
             if (elapsed < 30) {
                 // Likely just taxiing or bouncing on takeoff
                 return;
             }

             if (!this.firstGroundContact) {
                 this.firstGroundContact = true;
                 
                 // Calculate landing stats
                 const vs = this.calculatedVerticalSpeed !== 0 && Math.abs(this.calculatedVerticalSpeed) < 5000
                    ? this.calculatedVerticalSpeed
                    : values.verticalSpeed || 0;

                let quality = "CRASH";
                if (vs >= -50) quality = "SUPER BUTTER";
                else if (vs >= -200) quality = "BUTTER";
                else if (vs >= -500) quality = "ACCEPTABLE";
                else if (vs >= -1000) quality = "HARD";

                const apt = AirportManager.getNearest(lat, lon);
                this.arrivalICAO = apt ? (apt.icao || apt.iata || "UNKNOWN") : "UNKNOWN";

                if (vs <= -1000 || vs > 200) {
                    quality = "CRASH";
                    if (typeof showToast === 'function') showToast("💥 CRASH DETECTED");
                } else {
                    if (typeof showToast === 'function') showToast(`🛬 Landed at ${this.arrivalICAO} (${quality})`);
                }

                this.sendLog(vs, quality);
                this.flightStarted = false;
                this.justLanded = true;
             }
        }
    },

    calculateDistance(lat1, lon1, lat2, lon2) {
        const R = 6371;
        const dLat = (lat2 - lat1) * Math.PI / 180;
        const dLon = (lon2 - lon1) * Math.PI / 180;
        const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
                  Math.cos(lat1 * Math.PI/180) * Math.cos(lat2 * Math.PI/180) *
                  Math.sin(dLon/2) * Math.sin(dLon/2);
        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
        return R * c;
    },

    sendLog(vs, quality) {
        const callsign = getPlayerCallsign();
        
        let webhookUrl = null;
        let airlineCode = "GFS";

        // 1. Try 3-letter ICAO code
        const match3 = callsign.match(/^([A-Z]{3})/i);
        if (match3) {
            const code = match3[1].toUpperCase();
            if (this.webhooks[code]) {
                airlineCode = code;
                webhookUrl = this.webhooks[code];
            }
        }

        // 2. Try 2-letter IATA code if no ICAO match found
        if (!webhookUrl) {
            const match2 = callsign.match(/^([A-Z]{2})/i);
            if (match2) {
                const code = match2[1].toUpperCase();
                if (this.webhooks[code]) {
                    airlineCode = code;
                    webhookUrl = this.webhooks[code];
                }
            }
        }

        // 3. Fallback to GFS
        if (!webhookUrl) {
             webhookUrl = this.webhooks["GFS"];
        }

        if (!webhookUrl) {
            console.warn('[FlightLogger] No webhook found for callsign:', callsign);
            return;
        }

        const aircraft = getAircraftName();
        const durationMin = Math.round((Date.now() - this.flightStartTime) / 60000);
        const formattedDuration = `${Math.floor(durationMin / 60).toString().padStart(2, '0')}:${(durationMin % 60).toString().padStart(2, '0')}`;
        
        const pilotName = this.userInfo ? `<@${this.userInfo.discordId}>` : (callsign || "Unknown");

        let embedColor = 0x0099FF;
        if (quality === "CRASH") embedColor = 0xDC143C;
        else if (quality === "HARD") embedColor = 0xFF8000;
        else if (quality === "SUPER BUTTER") embedColor = 0x00FF00;

        // Use Server Logo Proxy
        // The server handles: Local File -> IATA Lookup -> CDN Redirect
        const httpUrl = WS_URL.startsWith('wss://') ? WS_URL.replace('wss://', 'https://') : WS_URL.replace('ws://', 'http://');
        const logoUrl = `${httpUrl}/logos/${airlineCode}.png`;

        const message = {
            embeds: [{
                title: "🛫 Flight Report - GeoFS",
                color: embedColor,
                thumbnail: { url: logoUrl },
                fields: [
                    { name: "✈️ Flight Information", value: `**Flight no.**: ${callsign}\n**Pilot**: ${pilotName}\n**Aircraft**: ${aircraft}`, inline: false },
                    { name: "📍 Route", value: `**Departure**: ${this.departureICAO}\n**Arrival**: ${this.arrivalICAO}`, inline: true },
                    { name: "⏱️ Duration", value: `**Time**: ${formattedDuration}`, inline: true },
                    { name: "📊 Landing", value: `**V/S**: ${vs.toFixed(1)} fpm\n**Quality**: ${quality}\n**Bounces**: ${this.bounces}`, inline: true }
                ],
                timestamp: new Date().toISOString(),
                footer: { text: "GeoFS Flight Logger" + (this.teleportWarnings > 0 ? " | ⚠️ Teleport Detected" : "") }
            }]
        };

        fetch(webhookUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(message)
        }).then(() => console.log('[FlightLogger] Log sent'))
          .catch(e => console.error('[FlightLogger] Failed to send log:', e));
    }
  };
  setTimeout(() => FlightLogger.init(), 5000);

    // ======= Update check (English) =======
  const CURRENT_VERSION = '3.2.2';
  const VERSION_JSON_URL = 'https://raw.githubusercontent.com/jthweb/JThweb/main/version.json';
  const UPDATE_URL = 'https://raw.githubusercontent.com/jthweb/JThweb/main/radar.user.js';
(function checkUpdate() {
  fetch(VERSION_JSON_URL)
    .then(r => r.json())
    .then(data => {
      if (data.version && data.version !== CURRENT_VERSION) {
        showModal(
          `✈️ GeoFS FlightRadar receiver new version available (${data.version})!<br>Please reinstall the latest user.js from GitHub.`,
          null,
          UPDATE_URL
        );
      }
    })
    .catch(() => {});
})();
  // --- WebSocket Management ---
  let ws;
  function updateStatusDot() {
    const statusDot = document.querySelector('.geofs-radar-status');
    if (!statusDot) return;

    if (ws && ws.readyState === 0) {
      statusDot.style.background = '#eab308'; // Connecting (Yellow)
      statusDot.style.boxShadow = '0 0 8px rgba(234, 179, 8, 0.5)';
    } else if (!ws || ws.readyState !== 1) {
      statusDot.style.background = '#ef4444'; // Disconnected (Red)
      statusDot.style.boxShadow = 'none';
    } else if (!isTransponderActive) {
      statusDot.style.background = '#3b82f6'; // Connected, Inactive (Blue)
      statusDot.style.boxShadow = '0 0 8px rgba(59, 130, 246, 0.5)';
    } else {
      statusDot.style.background = '#22c55e'; // Active (Green)
      statusDot.style.boxShadow = '0 0 10px #22c55e';
    }
  }

  function findAirportByCode(code) {
    const normalized = (code || '').toString().trim().toUpperCase();
    if (!normalized || !AirportManager.loaded) return null;
    return AirportManager.airportByCode.get(normalized) || null;
  }

  function formatAirportFullName(airport) {
    if (!airport) return '';
    return (airport.name || '').toString();
  }

  function refreshAirportTooltips() {
    const depEl = document.getElementById('depInput');
    const arrEl = document.getElementById('arrInput');
    if (!depEl || !arrEl) return;

    const depAirport = findAirportByCode(depEl.value);
    const arrAirport = findAirportByCode(arrEl.value);

    depEl.title = formatAirportFullName(depAirport);
    arrEl.title = formatAirportFullName(arrAirport);
  }

  function connect() {
    if (ws && (ws.readyState === 0 || ws.readyState === 1)) return;
    const statusDot = document.querySelector('.geofs-radar-status');
    if (statusDot) statusDot.style.background = '#eab308'; // Connecting (Yellow)

    try {
      ws = new WebSocket(WS_URL);
      ws.addEventListener('open', () => {
        log('WS connected to ' + WS_URL);
        updateStatusDot();
        safeSend({ type: 'hello', role: 'player' });
        showToast('Connected to Radar Server');
      });
      ws.addEventListener('close', () => {
        log('WS closed, retrying...');
        updateStatusDot();
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

  // Some browsers/userscript engines miss a single event-driven update;
  // keep the status dot accurate across reconnects/UI timing.
  setInterval(updateStatusDot, 1000);

  function safeSend(obj) {
    try {
      if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
    } catch (e) {
      console.warn('[ATC-Reporter] send error', e);
    }
  }

  // --- Utility Functions ---
  function getAircraftName() {
    try {
        // Try multiple sources for aircraft name
        return geofs?.aircraft?.instance?.aircraftRecord?.name || 
               geofs?.aircraft?.instance?.name || 
               geofs?.aircraft?.instance?.id || 
               'Unknown Aircraft';
    } catch (e) {
        return 'Unknown Aircraft';
    }
  }
  function getPlayerCallsign() {
    return geofs?.userRecord?.callsign || 'Unknown';
  }
  // --- AGL Calculation ---
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

  // --- Takeoff Detection ---
  function checkTakeoff(snap) {
    const onGround = geofs?.aircraft?.instance?.groundContact ?? true;
    
    // If we are already flying and haven't set a time, set it now (approximate)
    if (!onGround && !takeoffTimeUTC) {
        takeoffTimeUTC = new Date().toISOString();
    }

    if (wasOnGround && !onGround) {
      takeoffTimeUTC = new Date().toISOString();
      console.log('[ATC-Reporter] Takeoff at', takeoffTimeUTC);
      
      if (snap) {
          const apt = AirportManager.getNearest(snap.lat, snap.lon);
          if (apt) {
              actualDeparture = apt.icao || apt.iata || apt.name;
              showToast(`Departed from ${apt.name}`);
          }
      }
      actualArrival = null;
    }

    if (!wasOnGround && onGround) {
        if (snap) {
            const apt = AirportManager.getNearest(snap.lat, snap.lon);
            if (apt) {
                actualArrival = apt.icao || apt.iata || apt.name;
                showToast(`Landed at ${apt.name}`);
            }
        }
    }

    wasOnGround = onGround;
  }

  // --- Flight Status Snapshot ---
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
      const now = Date.now();
      
      // Try to get ground speed first (m/s -> knots), then KIAS
      let speed = 0;
      // groundSpeed is usually in m/s in GeoFS backend
      if (typeof geofs?.animation?.values?.groundSpeed === 'number') {
          speed = geofs.animation.values.groundSpeed * 1.94384;
      } else if (typeof geofs?.animation?.values?.kias === 'number') {
          speed = geofs.animation.values.kias;
      } else if (typeof geofs?.aircraft?.instance?.trueAirSpeed === 'number') {
          speed = geofs.aircraft.instance.trueAirSpeed * 1.94384;
      }

      let vsFpm = 0;
      const vsRaw = geofs?.animation?.values?.verticalSpeed ??
                   geofs?.animation?.values?.verticalVelocity ??
                   geofs?.animation?.values?.verticalSpeedFPM ??
                   geofs?.animation?.values?.verticalSpeedFpm ??
                   geofs?.animation?.values?.vs;

      if (typeof vsRaw === 'number') {
        const abs = Math.abs(vsRaw);
        // If the magnitude is small, assume m/s and convert; otherwise assume already fpm
        vsFpm = abs <= 50 ? Math.round(vsRaw * 196.8504) : Math.round(vsRaw);
      }

      if (!vsFpm && typeof altMSL === 'number') {
        const dtMs = now - (prevAltTs || now);
        if (dtMs > 0 && prevAltMSL !== null) {
          vsFpm = Math.round((altMSL - prevAltMSL) / (dtMs / 60000));
        }
        prevAltMSL = altMSL;
        prevAltTs = now;
      } else {
        prevAltMSL = altMSL;
        prevAltTs = now;
      }

      // Wind Data
      let windSpeed = 0;
      let windDir = 0;
      if (geofs?.animation?.values?.windSpeed) {
          windSpeed = geofs.animation.values.windSpeed * 1.94384; // m/s to knots
      }
      if (geofs?.animation?.values?.windDir) {
          windDir = geofs.animation.values.windDir;
      }

      return { lat, lon, altMSL, altAGL, heading, speed: parseFloat(speed.toFixed(1)), verticalSpeedFpm: vsFpm, windSpeed, windDir };
    } catch (e) {
      console.warn('[ATC-Reporter] readSnapshot error:', e);
      return null;
    }
  }

  // --- Build Payload ---
function buildPayload(snap) {
  checkTakeoff();
  // Debug Log
  if (Math.random() < 0.05) { // Log occasionally to avoid spam
      console.log('[ATC-Reporter] Snapshot:', snap, 'FlightInfo:', flightInfo);
  }
  
  let flightPlan = [];
  try {
    if (geofs.flightPlan && typeof geofs.flightPlan.export === "function") {
      flightPlan = geofs.flightPlan.export();
    }
  } catch (e) {}
 const userId = geofs?.userRecord?.id || null;
  
  // Use manual callsign if entered, otherwise fallback to GeoFS username
  const finalCallsign = flightInfo.flightNo ? flightInfo.flightNo : getPlayerCallsign();

  return {
    id: getPlayerCallsign(), // Keep ID as unique user identifier
    callsign: finalCallsign,
    type: getAircraftName(),
    lat: snap.lat,
    lon: snap.lon,
    alt: (typeof snap.altAGL === 'number') ? snap.altAGL : Math.round(snap.altMSL || 0),
    altMSL: Math.round(snap.altMSL || 0),
    heading: Math.round(snap.heading || 0),
    speed: Math.round(snap.speed || 0),
    verticalSpeed: snap.verticalSpeedFpm || 0,
    verticalSpeedFpm: snap.verticalSpeedFpm || 0,
    vs: snap.verticalSpeedFpm || 0,
    windSpeed: Math.round(snap.windSpeed || 0),
    windDir: Math.round(snap.windDir || 0),
    flightNo: flightInfo.flightNo,
    registration: flightInfo.registration,
    departure: flightInfo.departure,
    arrival: flightInfo.arrival,
    actualDeparture: actualDeparture,
    actualArrival: actualArrival,
    takeoffTime: takeoffTimeUTC,
    squawk: flightInfo.squawk,
    flightPlan: flightPlan,
    nextWaypoint: geofs.flightPlan?.trackedWaypoint?.ident || null,
    userId: userId,
    playerId: userId, // Ensure stable ID generation on server
    apiKey: localStorage.getItem('geofs_flightradar_apikey') || null
  };
}

  // --- Periodic Send ---
  let lastFlightPlanHash = "";
  
  setInterval(() => {
    try {
      if (!ws || ws.readyState !== 1) return;
      
      if (!isTransponderActive) {
        // Send heartbeat every 10 seconds to keep connection alive
        if (Date.now() % 10000 < SEND_INTERVAL_MS) {
          safeSend({ type: 'heartbeat' });
        }
        return;
      }

      const snap = readSnapshot();
      if (!snap) return;
      
      const payload = buildPayload(snap);
      
      // Optimize: Only send flight plan if it changed
      const currentPlanHash = JSON.stringify(payload.flightPlan);
      if (currentPlanHash === lastFlightPlanHash) {
          delete payload.flightPlan;
      } else {
          lastFlightPlanHash = currentPlanHash;
      }
      
      safeSend({ type: 'position_update', payload });
    } catch (e) {
      console.warn('[ATC-Reporter] Periodic send error:', e);
    }
  }, SEND_INTERVAL_MS);

  // --- Toast Notification ---
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


  // --- UI Injection ---
  function injectFlightUI() {
    flightUI = document.createElement('div');
    flightUI.id = 'flightInfoUI';
    flightUI.style.position = 'fixed';
    flightUI.style.bottom = '280px';
    flightUI.style.right = '20px';
    flightUI.style.zIndex = 999999;

    flightUI.innerHTML = `
      <style>
        .geofs-radar-panel {
          font-family: "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
          width: 240px;
          background: rgba(22, 25, 32, 0.65);
          backdrop-filter: blur(12px) saturate(180%);
          -webkit-backdrop-filter: blur(12px) saturate(180%);
          border: 1px solid rgba(255, 255, 255, 0.12);
          border-radius: 16px;
          padding: 20px;
          box-shadow: 0 8px 32px 0 rgba(0, 0, 0, 0.37);
          color: #e2e8f0;
          transition: opacity 0.2s ease;
          cursor: grab; /* indicate draggable area */
        }
        .geofs-radar-input, .geofs-radar-btn, .geofs-radar-min-btn { cursor: default; /* interactive controls keep default cursor */ }
        .geofs-radar-header {
          font-size: 11px;
          text-transform: uppercase;
          letter-spacing: 2px;
          color: rgba(255, 255, 255, 0.8);
          margin-bottom: 16px;
          font-weight: 800;
          display: flex;
          justify-content: space-between;
          align-items: center;
          cursor: move;
          user-select: none;
          text-shadow: 0 2px 4px rgba(0,0,0,0.3);
        }
        .geofs-radar-header-controls {
            display: flex;
            gap: 8px;
            align-items: center;
        }
        .geofs-radar-min-btn {
            cursor: pointer;
            color: rgba(255, 255, 255, 0.6);
            transition: color 0.2s;
            font-size: 14px;
            line-height: 1;
            padding: 4px;
        }
        .geofs-radar-min-btn:hover { color: #fff; }
        .geofs-radar-status {
            width: 8px; height: 8px; background: #64748b; border-radius: 50%; box-shadow: 0 0 8px rgba(100, 116, 139, 0.5); transition: all 0.3s;
        }
        .geofs-radar-grid {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 12px;
          margin-bottom: 16px;
        }
        .geofs-radar-group {
          display: flex;
          flex-direction: column;
          gap: 6px;
        }
        .geofs-radar-label {
          font-size: 10px;
          color: rgba(255, 255, 255, 0.5);
          font-weight: 700;
          text-transform: uppercase;
          letter-spacing: 0.5px;
        }
        .geofs-radar-input {
          background: rgba(255, 255, 255, 0.05);
          border: 1px solid rgba(255, 255, 255, 0.1);
          border-radius: 8px;
          padding: 8px 10px;
          color: #fff;
          font-size: 13px;
          font-weight: 600;
          width: 100%;
          box-sizing: border-box;
          transition: all 0.2s;
          text-transform: uppercase;
          font-family: monospace;
        }
        .geofs-radar-input:focus {
          outline: none;
          border-color: rgba(59, 130, 246, 0.5);
          background: rgba(255, 255, 255, 0.1);
          box-shadow: 0 0 0 2px rgba(59, 130, 246, 0.2);
        }
        .geofs-radar-btn {
          width: 100%;
          background: rgba(59, 130, 246, 0.2);
          border: 1px solid rgba(59, 130, 246, 0.3);
          border-radius: 8px;
          color: #60a5fa;
          padding: 10px;
          font-size: 12px;
          font-weight: 700;
          cursor: pointer;
          letter-spacing: 0.5px;
          text-transform: uppercase;
          transition: all 0.2s;
          backdrop-filter: blur(4px);
        }
        .geofs-radar-btn:hover {
          background: rgba(59, 130, 246, 0.3);
          border-color: rgba(59, 130, 246, 0.5);
          color: #fff;
          box-shadow: 0 0 15px rgba(59, 130, 246, 0.3);
          transform: translateY(-1px);
        }
        .geofs-radar-btn:active {
          transform: translateY(1px);
        }
        .geofs-radar-content {
            transition: max-height 0.3s ease, opacity 0.3s ease;
            max-height: 500px;
            opacity: 1;
            overflow: hidden;
        }
        .geofs-radar-content.minimized {
            max-height: 0;
            opacity: 0;
            margin: 0;
        }
      </style>
      <div class="geofs-radar-panel">
        <div class="geofs-radar-header" id="radarHeader">
          <span>Flight Data</span>
          <div class="geofs-radar-header-controls">
            <div class="geofs-radar-status"></div>
            <div class="geofs-radar-min-btn" id="minBtn" title="Minimize">_</div>
            <div class="geofs-radar-min-btn" id="closeBtn" title="Hide (Press W)">×</div>
          </div>
        </div>
        <div class="geofs-radar-content" id="radarContent">
            <div class="geofs-radar-grid">
            <div class="geofs-radar-group">
                <label class="geofs-radar-label">Origin</label>
                <input id="depInput" class="geofs-radar-input" placeholder="----" maxlength="4" value="${flightInfo.departure}">
            </div>
            <div class="geofs-radar-group">
                <label class="geofs-radar-label">Dest</label>
                <input id="arrInput" class="geofs-radar-input" placeholder="----" maxlength="4" value="${flightInfo.arrival}">
            </div>
            <div class="geofs-radar-group">
                <label class="geofs-radar-label">Callsign</label>
                <input id="fltInput" class="geofs-radar-input" placeholder="UNK" value="${flightInfo.flightNo}">
            </div>
            <div class="geofs-radar-group">
                <label class="geofs-radar-label">Reg</label>
                <input id="regInput" class="geofs-radar-input" placeholder="REG" value="${flightInfo.registration}">
            </div>
            <div class="geofs-radar-group">
                <label class="geofs-radar-label">Squawk</label>
                <input id="sqkInput" class="geofs-radar-input" placeholder="7000" maxlength="4" value="${flightInfo.squawk}">
            </div>
            <div class="geofs-radar-group" style="grid-column: span 2;">
                <label class="geofs-radar-label">API Key (Required)</label>
                <input id="apiKeyInput" class="geofs-radar-input" placeholder="Paste Key from Radar Website (required)" value="${localStorage.getItem('geofs_flightradar_apikey') || ''}" style="font-size: 11px;">
            </div>
            </div>
            <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap;">
                <button id="saveBtn" class="geofs-radar-btn" style="flex:1;min-width:160px;">Update Transponder</button>
                <button id="landedBtn" class="geofs-radar-btn" style="background:rgba(59, 130, 246, 0.2);border:2px solid rgba(59, 130, 246, 0.4);color:#bfdbfe;font-weight:800;min-width:140px;">🛬 Mark Landed</button>
                <button id="stopBtn" class="geofs-radar-btn" style="background:rgba(239, 68, 68, 0.3);border:2px solid rgba(239, 68, 68, 0.5);color:#fca5a5;font-weight:800;min-width:80px;">🛑 Stop</button>
            </div>
        </div>
      </div>
    `;

    document.body.appendChild(flightUI);
    updateStatusDot();
    refreshAirportTooltips();

    // Drag Logic
    const header = document.getElementById('radarHeader');
    // Allow dragging from any non-interactive part of the window
    const dragRoot = flightUI;

    let isDragging = false;
    let currentX;
    let currentY;
    let initialX;
    let initialY;
    let xOffset = 0;
    let yOffset = 0;

    // Load saved position
    try {
        const savedPos = localStorage.getItem('geofs_radar_ui_pos');
        if (savedPos) {
            const pos = JSON.parse(savedPos);
            xOffset = pos.x;
            yOffset = pos.y;
            setTranslate(xOffset, yOffset, flightUI);
        }
    } catch(e) {}

    // Use the whole panel as the drag root; ignore interactive controls
    dragRoot.addEventListener("mousedown", dragStart);
    document.addEventListener("mouseup", dragEnd);
    document.addEventListener("mousemove", drag);

    // Touch support
    dragRoot.addEventListener("touchstart", dragStart, { passive: false });
    document.addEventListener("touchend", dragEnd);
    document.addEventListener("touchmove", drag, { passive: false });

    function isInteractiveTarget(target) {
      return target.closest('input, textarea, select, button, a, label, .geofs-radar-btn, .geofs-radar-min-btn') !== null;
    }

    function getClientXY(e) {
      if (e.touches && e.touches[0]) return { x: e.touches[0].clientX, y: e.touches[0].clientY };
      return { x: e.clientX, y: e.clientY };
    }

    function dragStart(e) {
      // Don't start dragging when interacting with form controls or buttons
      if (isInteractiveTarget(e.target)) return;

      const pos = getClientXY(e);
      initialX = pos.x - xOffset;
      initialY = pos.y - yOffset;

      isDragging = true;
      // visual cue
      document.body.style.cursor = 'grabbing';
    }

    function dragEnd(e) {
      initialX = currentX;
      initialY = currentY;
      isDragging = false;
      document.body.style.cursor = '';

      // Save position
      localStorage.setItem('geofs_radar_ui_pos', JSON.stringify({ x: xOffset, y: yOffset }));
    }

    function drag(e) {
      if (!isDragging) return;
      e.preventDefault();
      const pos = getClientXY(e);
      currentX = pos.x - initialX;
      currentY = pos.y - initialY;

      xOffset = currentX;
      yOffset = currentY;

      setTranslate(currentX, currentY, flightUI);
    }

    function setTranslate(xPos, yPos, el) {
      el.style.transform = "translate3d(" + xPos + "px, " + yPos + "px, 0)";
    }

    // Minimize Logic
    const minBtn = document.getElementById('minBtn');
    const closeBtn = document.getElementById('closeBtn');
    const content = document.getElementById('radarContent');
    
    minBtn.addEventListener('mousedown', (e) => e.stopPropagation());
    minBtn.onclick = (e) => {
        e.stopPropagation();
        content.classList.toggle('minimized');
        minBtn.textContent = content.classList.contains('minimized') ? '□' : '_';
    };

    closeBtn.addEventListener('mousedown', (e) => e.stopPropagation());
    closeBtn.onclick = (e) => {
        e.stopPropagation();
        e.preventDefault();
        flightUI.style.display = 'none';
        showToast('Press W to show Flight Info');
    };

    // Auto-uppercase input fields
    ['depInput','arrInput','fltInput','sqkInput', 'regInput'].forEach(id => {
      const el = document.getElementById(id);
      el.addEventListener('input', () => {
        el.value = el.value.toUpperCase();
      });
    });

    // Airport full-name tooltips on hover
    ['depInput', 'arrInput'].forEach((id) => {
      const el = document.getElementById(id);
      el.addEventListener('input', refreshAirportTooltips);
      el.addEventListener('blur', refreshAirportTooltips);
      el.addEventListener('mouseenter', refreshAirportTooltips);
    });

    document.getElementById('saveBtn').onclick = () => {
      flightInfo.departure = document.getElementById('depInput').value.trim();
      flightInfo.arrival = document.getElementById('arrInput').value.trim();
      flightInfo.flightNo = document.getElementById('fltInput').value.trim();
      flightInfo.squawk = document.getElementById('sqkInput').value.trim();
      flightInfo.registration = document.getElementById('regInput').value.trim();
      
      const apiKey = document.getElementById('apiKeyInput').value.trim();
      // API Key is required. If the user is a pilot in-game they MUST provide an API key (log into the website to get one)
      if (!apiKey) {
          if (geofs && geofs.userRecord && geofs.userRecord.id) {
              return showToast('API Key required for pilots. Please log in on the website to obtain your API Key.');
          }
          return showToast('API Key is required. Obtain one from the website and paste it here.');
      }

      localStorage.setItem('geofs_flightradar_apikey', apiKey);
      localStorage.setItem('geofs_radar_flightinfo', JSON.stringify(flightInfo));
      
      isTransponderActive = true;
      localStorage.setItem('geofs_radar_transponder_active', 'true');
      updateStatusDot();
      refreshAirportTooltips();
      
      showToast('Transponder Updated & Active');
    };
    
    // Stop Transponder Button Handler
    document.getElementById('stopBtn').onclick = () => {
      isTransponderActive = false;
      localStorage.setItem('geofs_radar_transponder_active', 'false');
      updateStatusDot();
      showToast('Transponder Stopped');
    };

    // Landed Button Handler - send manual land message to server
    document.getElementById('landedBtn').onclick = () => {
      const snap = readSnapshot();
      if (!snap) return showToast('Unable to capture position');
      safeSend({ type: 'manual_land', payload: {
        callsign: getPlayerCallsign(),
        lat: snap.lat,
        lon: snap.lon,
        alt: snap.altMSL || 0,
        userId: geofs?.userRecord?.id || null,
        ts: Date.now()
      }});
      showToast('Marked as Landed (admin notified)');
    };
  }
  injectFlightUI();
  


  // --- Hotkey W to Toggle UI ---
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

  // --- Disable Autocomplete for Inputs ---
  document.querySelectorAll("input").forEach(el => {
    el.setAttribute("autocomplete", "off");
  });

  // --- Prevent Input from Triggering GeoFS Hotkeys ---
  document.addEventListener("keydown", (e) => {
    const target = e.target;
    if (target.tagName === "INPUT" || target.tagName === "TEXTAREA") {
      e.stopPropagation();
    }
  }, true);

})();
