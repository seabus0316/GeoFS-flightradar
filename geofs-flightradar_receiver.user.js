// ==UserScript==
// @name         GeoFS-flightradar receiver
// @namespace    http://tampermonkey.net/
// @version      1.9.6
// @description  Always loads the latest GeoFS flightradar script from GitHub
// @author       SeaBus
// @match        http://*/geofs.php*
// @match        https://*/geofs.php*
// @grant        GM_xmlhttpRequest
// @connect      raw.githubusercontent.com
// @connect      cdn.socket.io
// @connect      geofs-flightradar.duckdns.org
// ==/UserScript==

(function () {
    // ========== 用戶設定 ==========
    // 選項: 'websocket' 或 'socket.io'
    // 如果遇到 WebSocket 連線問題，改成 'socket.io'
    // options: 'http', 'websocket', 'socket.io'
    const mode = 'websocket';
    // ==============================

    const BASE = 'https://raw.githubusercontent.com/seabus0316/GeoFS-flightradar/refs/heads/main/';
    const scripts = [];
    if (mode === 'http') {
        scripts.push('http.js');
    } else {
        if (mode === 'socket.io') {
            scripts.push('socketio.js');
        }
        scripts.push('userscript.js');
    }
    scripts.push('radarthing.js');

    // 將設定傳給全域物件，讓 userscript.js 可以訪問
    window.geofsFlightRadarConfig = {
        mode: mode
    };

    function loadScript(url) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'GET',
                url: url + '?t=' + Date.now(),
                headers: {
                    'Cache-Control': 'no-cache, no-store',
                    'Pragma': 'no-cache'
                },
                onload: (res) => {
                    if (res.status === 200) {
                        // eslint-disable-next-line no-eval
                        eval(res.responseText);
                        resolve();
                    } else {
                        reject(new Error(`HTTP ${res.status} for ${url}`));
                    }
                },
                onerror: reject
            });
        });
    }

    // 依序載入，保持執行順序
    scripts.reduce(
        (chain, file) => chain.then(() => loadScript(BASE + file)),
        Promise.resolve()
    );
})();
