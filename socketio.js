(function () {
  'use strict';

  /**
   * Socket.IO 連線模組
   * 專門處理 Socket.IO 連線及通訊
   * （已整合 Flight Info UI）
   */

  // ─────────────────────────────────────────────
  // 工具函式   
  // ─────────────────────────────────────────────

  function log(...args) {
    console.log('[ATC-Reporter]', ...args);
  }

  // ─────────────────────────────────────────────
  // Modal
  // ─────────────────────────────────────────────

  function showModal(msg, duration = null, updateBtnUrl = null) {
    if (document.getElementById('geofs-atc-modal')) return;
    let overlay = document.createElement('div');
    overlay.id = 'geofs-atc-modal';
    overlay.style.cssText = `
      position:fixed;top:0;left:0;width:100vw;height:100vh;z-index:99999;
      background:rgba(24,32,48,0.45);display:flex;align-items:center;justify-content:center;
    `;
    let box = document.createElement('div');
    box.style.cssText = `
      background:linear-gradient(135deg,#232942 80%,#151a25 100%);
      color:#dbeaff;padding:30px 34px;border-radius:18px;box-shadow:0 6px 32px #000b;
      min-width:280px;max-width:90vw;display:flex;flex-direction:column;align-items:center;gap:14px;
      border:2.5px solid #3d6aff;font-size:1.15rem;letter-spacing:0.3px;
      text-align:center;animation:popIn .21s;
    `;
    let content = document.createElement('div');
    content.innerHTML = msg;
    box.appendChild(content);

    if (updateBtnUrl) {
      let updateBtn = document.createElement('a');
      updateBtn.textContent = 'Update';
      updateBtn.href = updateBtnUrl;
      updateBtn.target = '_blank';
      updateBtn.style.cssText = `
        margin-top:6px;padding:8px 38px;font-size:1.05rem;background:#1e3f6e;
        color:#fff;border:1.5px solid #4eaaff;border-radius:7px;font-weight:bold;cursor:pointer;
        box-shadow:0 1px 8px #4eaaff30;transition:background .18s;display:inline-block;text-decoration:none;
      `;
      updateBtn.onmouseover = function () { this.style.background = '#1552a1'; };
      updateBtn.onmouseout = function () { this.style.background = '#1e3f6e'; };
      box.appendChild(updateBtn);
    }

    let okBtn = document.createElement('button');
    okBtn.textContent = 'OK';
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

    overlay.tabIndex = -1;
    overlay.focus();
    overlay.onkeydown = (e) => {
      if (e.key === 'Enter' || e.key === 'Escape') {
        if (document.body.contains(overlay)) document.body.removeChild(overlay);
      }
    };

    if (!document.getElementById('geofs-atc-modal-anim')) {
      const style = document.createElement('style');
      style.id = 'geofs-atc-modal-anim';
      style.textContent = `
        @keyframes popIn { from { transform:scale(0.85);opacity:0; } to { transform:scale(1);opacity:1; } }
      `;
      document.head.appendChild(style);
    }
  }

  // ─────────────────────────────────────────────
  // Toast
  // ─────────────────────────────────────────────

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

  function showLoginToast(msg = 'Your GeoFS account is not linked to Discord! Please log in to use full features.') {
    if (document.getElementById('geofs-login-toast')) return;
    const toast = document.createElement('div');
    toast.id = 'geofs-login-toast';
    toast.style.cssText = 'position:fixed;top:80px;left:50%;transform:translateX(-50%);background:linear-gradient(135deg, #1e3f6e, #151a25);color:#fff;padding:15px;border-radius:10px;font-size:14px;z-index:1000000;box-shadow:0 4px 12px rgba(0,0,0,0.5);border:1.5px solid #4eaaff;display:flex;flex-direction:column;gap:10px;animation:popIn .3s ease;';
    toast.innerHTML = `
      <div>${msg}</div>
      <div style="display:flex;gap:8px;justify-content:flex-end;">
        <a href="https://geofs-flightradar.duckdns.org/auth/discord" target="_blank" style="padding:6px 12px;background:#4eaaff;color:#000;text-decoration:none;border-radius:5px;font-weight:bold;font-size:12px;">Login & Link</a>
        <button style="padding:6px 12px;background:#333;color:#fff;border:none;border-radius:5px;cursor:pointer;font-size:12px;" onclick="this.parentElement.parentElement.remove()">Close</button>
      </div>
    `;
    document.body.appendChild(toast);
  }

  // ─────────────────────────────────────────────
  // Flight Info 全域狀態
  // ─────────────────────────────────────────────

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
  const flightInfo = window.geofsFlightInfo;

  // ─────────────────────────────────────────────
  // Flight Plan 解析輔助函式
  // ─────────────────────────────────────────────

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
          if (current.length && current.some(looksLikeWaypoint)) return current;
          for (const item of current) {
            if (item && typeof item === 'object') queue.push(item);
          }
          continue;
        }

        for (const value of Object.values(current)) {
          if (!value) continue;
          if (Array.isArray(value)) {
            if (value.length && value.some(looksLikeWaypoint)) return value;
            queue.push(value);
            continue;
          }
          if (typeof value === 'object') queue.push(value);
        }
      }
      return [];
    }

    try {
      const fp = geofs?.flightPlan; // eslint-disable-line no-undef
      if (!fp) return [];
      if (typeof fp.export === 'function') {
        const exported = fp.export();
        if (Array.isArray(exported)) return exported;
        const exportedPlan = findWaypointArray(exported);
        if (exportedPlan.length) return exportedPlan;
      }
      const livePlan = findWaypointArray(fp);
      if (livePlan.length) return livePlan;
    } catch (e) { /* ignore */ }
    return [];
  }

  function extractWaypointLabel(waypoint) {
    if (!waypoint) return '';
    if (typeof waypoint === 'string') return waypoint.trim().toUpperCase();

    const candidates = [
      waypoint.ident, waypoint.name, waypoint.icao,
      waypoint.iata, waypoint.airport, waypoint.code
    ];
    for (const value of candidates) {
      if (typeof value === 'string' && value.trim()) return value.trim().toUpperCase();
    }
    return '';
  }

  // ─────────────────────────────────────────────
  // UI 圖示
  // ─────────────────────────────────────────────

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

  // ─────────────────────────────────────────────
  // Flight Info UI 注入
  // ─────────────────────────────────────────────

  let flightUI;

  function injectFlightUI() {
    flightUI = document.createElement('div');
    flightUI.style.cssText =
      'position:fixed;bottom:280px;right:6px;background:rgba(0,0,0,0.6);padding:8px;border-radius:6px;color:white;font-size:12px;z-index:999999';

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

    const depInput = document.getElementById('depInput');
    const arrInput = document.getElementById('arrInput');
    const fltInput = document.getElementById('fltInput');
    const sqkInput = document.getElementById('sqkInput');
    const fetchPlanBtn = document.getElementById('fetchPlanBtn');
    const saveBtn = document.getElementById('saveBtn');
    const divertBtn = document.getElementById('divertBtn');

    [depInput, arrInput, fltInput, sqkInput].forEach((input) => {
      input.style.textTransform = 'uppercase';
      input.addEventListener('input', () => {
        input.value = input.value.toUpperCase();
        flightInfo.confirmed = false;
      });
    });

    fetchPlanBtn.addEventListener('mouseenter', () => { fetchPlanBtn.style.background = '#1552a1'; });
    fetchPlanBtn.addEventListener('mouseleave', () => { fetchPlanBtn.style.background = '#1e3f6e'; });

    divertBtn.addEventListener('mouseenter', () => { divertBtn.style.background = '#7a2824'; });
    divertBtn.addEventListener('mouseleave', () => { divertBtn.style.background = '#5c1d1a'; });

    fetchPlanBtn.onclick = () => {
      const plan = getExportedFlightPlan();
      if (plan.length < 2) {
        console.log('[ATC-Reporter] geofs.flightPlan debug:', geofs?.flightPlan); // eslint-disable-line no-undef
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

      if (!flightInfo.confirmed || !originalArrival) { showToast('Save original flight first'); return; }
      if (!newArrival) { showToast('Arrival airport required'); return; }
      if (newArrival === originalArrival) { showToast('Arrival unchanged'); return; }

      flightInfo.actualArrival = newArrival;
      flightInfo.isDiverted = true;
      flightInfo.confirmed = Boolean(flightInfo.departure && flightInfo.arrival);
      showToast(`Diverting to ${newArrival}`);
    };
  }

  injectFlightUI();

  // 快捷鍵 W 收合 UI
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

  // 關閉所有 input 的 autocomplete
  document.querySelectorAll('input').forEach(el => el.setAttribute('autocomplete', 'off'));

  // 防止 input 觸發 GeoFS hotkey
  document.addEventListener('keydown', (e) => {
    const target = e.target;
    if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') {
      e.stopPropagation();
    }
  }, true);

  // ─────────────────────────────────────────────
  // Socket.IO 連線（原有邏輯，未更動）
  // ─────────────────────────────────────────────

  function ensureSocketIOLibrary() {
    return new Promise((resolve) => {
      if (typeof io !== 'undefined') { resolve(); return; }
      if (window.io) { resolve(); return; }

      if (typeof GM_xmlhttpRequest !== 'undefined') {
        GM_xmlhttpRequest({
          method: 'GET',
          url: 'https://cdn.socket.io/4.5.4/socket.io.min.js',
          headers: {
            'Cache-Control': 'no-cache, no-store',
            'Pragma': 'no-cache'
          },
          onload: (res) => {
            if (res.status === 200) {
              try {
                // eslint-disable-next-line no-eval
                eval(res.responseText);
              } catch (e) {
                console.error('[ATC-Reporter] Socket.IO eval error:', e);
              }
              resolve();
            } else {
              console.error('[ATC-Reporter] HTTP ' + res.status + ' loading Socket.IO');
              resolve();
            }
          },
          onerror: (err) => {
            console.error('[ATC-Reporter] Failed to load Socket.IO library via GM', err);
            resolve();
          }
        });
      } else {
        const script = document.createElement('script');
        script.src = 'https://cdn.socket.io/4.5.4/socket.io.min.js';
        script.onload = () => {
          setTimeout(resolve, 50); // wait a bit for it to attach to window
        };
        script.onerror = () => {
          console.error('[ATC-Reporter] Failed to load Socket.IO library');
          resolve();
        };
        document.head.appendChild(script);
      }
    });
  }

  // 初始化 Socket.IO 連線
  async function initSocketIOConnection(wsUrl) {
    await ensureSocketIOLibrary();

    let socketIo = typeof io !== 'undefined' ? io : window.io;
    if (!socketIo) {
      console.error('[ATC-Reporter] Socket.IO library not available');
      return null;
    }

    const SOCKET_IO_URL = 'https://geofs-flightradar.duckdns.org';

    try {
      const socket = socketIo(socketUrl, {
        reconnection: true,
        reconnectionDelay: 2000,
        reconnectionDelayMax: 10000,
        reconnectionAttempts: Infinity,
        transports: ['websocket', 'polling'], // 先試 WebSocket，失敗時降級到 polling
        secure: socketUrl.startsWith('wss') || socketUrl.startsWith('https')
      });

      return socket;
    } catch (e) {
      console.error('[ATC-Reporter] Socket.IO initialization error:', e);
      return null;
    }
  }

  // 暴露給全域，讓 userscript.js 使用
  window.GeoFSSocketIO = {
    initSocketIOConnection: initSocketIOConnection,
    ensureSocketIOLibrary: ensureSocketIOLibrary
  };

  // 同時暴露 UI 工具，方便外部模組呼叫
  window.GeoFSSocketIO.showModal = showModal;
  window.GeoFSSocketIO.showToast = showToast;
  window.GeoFSSocketIO.showLoginToast = showLoginToast;

  log('Socket.IO module loaded (with Flight Info UI)');
})();
