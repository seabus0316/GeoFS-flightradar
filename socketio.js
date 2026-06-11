(function () {
  'use strict';

  /**
   * Socket.IO 連線模組
   * 專門處理 Socket.IO 連線及通訊
   */

  function ensureSocketIOLibrary() {
    return new Promise((resolve) => {
      if (typeof io !== 'undefined') {
        resolve();
        return;
      }
      if (window.io) {
        resolve();
        return;
      }

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

    const socketUrl = wsUrl.replace(/\/ws$/, ''); // 移除 /ws 路徑

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

  console.log('[ATC-Reporter] Socket.IO module loaded');
})();
