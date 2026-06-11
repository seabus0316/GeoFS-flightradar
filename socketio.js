(function () {
  'use strict';

  /**
   * Socket.IO 連線模組
   * 專門處理 Socket.IO 連線及通訊
   */

  // 檢查 Socket.IO 庫是否已載入
  function ensureSocketIOLibrary() {
    return new Promise((resolve) => {
      if (window.io) {
        resolve();
        return;
      }

      const script = document.createElement('script');
      script.src = 'https://cdn.socket.io/4.5.4/socket.io.min.js';
      script.onload = resolve;
      script.onerror = () => {
        console.error('[ATC-Reporter] Failed to load Socket.IO library');
        resolve(); // 即使失敗也繼續，讓 userscript.js 可以降級
      };
      document.head.appendChild(script);
    });
  }

  // 初始化 Socket.IO 連線
  async function initSocketIOConnection(wsUrl) {
    await ensureSocketIOLibrary();

    if (!window.io) {
      console.error('[ATC-Reporter] Socket.IO library not available');
      return null;
    }

    const socketUrl = wsUrl.replace(/\/ws$/, ''); // 移除 /ws 路徑

    try {
      const socket = window.io(socketUrl, {
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

  console.log('[ATC-Reporter] Socket.IO module loaded');
})();
