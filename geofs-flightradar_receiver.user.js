// ==UserScript==
// @name         GeoFS-flightradar receiver
// @namespace    http://tampermonkey.net/
// @version      1.9.4
// @description  Always loads the latest GeoFS flightradar script from GitHub
// @author       SeaBus
// @match        http://*/geofs.php*
// @match        https://*/geofs.php*
// @grant        GM_xmlhttpRequest
// @connect      raw.githubusercontent.com
// ==/UserScript==

(function () {
    const BASE = 'https://raw.githubusercontent.com/seabus0316/GeoFS-flightradar/refs/heads/main/';
    const scripts = ['userscript.js', 'radarthing.js'];

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