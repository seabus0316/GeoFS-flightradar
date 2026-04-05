/**
 * ✈️ GeoFS Flightradar — Aircraft Icon System
 * 使用 planes.json + /icons/*.svg 對應真實機型圖標
 *
 * 放到 public/ 資料夾，然後在 atc.html 引入：
 *   <script src="/aircraft-icons.js"></script>
 */

// ─────────────────────────────────────────────────────────────
// 1. 從 planes.json 建立查詢表（啟動時非同步載入一次）
// ─────────────────────────────────────────────────────────────
const AircraftIconDB = {
  _map: {},       // model小寫 → icon檔名
  _loaded: false,
  _loadPromise: null,

  async load(jsonPath = '/planes.json') {
    if (this._loaded) return;
    if (this._loadPromise) return this._loadPromise;

    this._loadPromise = fetch(jsonPath)
      .then(r => r.json())
      .then(data => {
        for (const entry of data) {
          if (entry.model && entry.icon) {
            this._map[entry.model.toLowerCase().trim()] = entry.icon;
          }
        }
        this._loaded = true;
        console.log(`[AircraftIcons] Loaded ${Object.keys(this._map).length} entries`);
      })
      .catch(e => {
        console.warn('[AircraftIcons] Failed to load planes.json', e);
        this._loaded = true;
      });

    return this._loadPromise;
  },

  /**
   * 根據 GeoFS type 字串解析對應的 SVG 檔名
   * GeoFS 的 type 欄位就是完整機型名，e.g. "Boeing 737-800"
   */
  resolve(typeStr) {
    if (!typeStr) return 'b767.svg';
    const t = String(typeStr).toLowerCase().trim();

    // ① 完整 key 直接命中
    if (this._map[t]) return this._map[t];

    // ② 模糊：planes.json 的 key 包含輸入，或輸入包含 key
    for (const [key, icon] of Object.entries(this._map)) {
      if (t.includes(key) || key.includes(t)) return icon;
    }

    // ③ Keyword fallback（兜底，應對 planes.json 未收錄的機型）
    if (/a380/.test(t))                                                    return 'a380.svg';
    if (/a35\d|a350/.test(t))                                              return 'a330.svg';
    if (/a33\d|a330/.test(t))                                              return 'a330.svg';
    if (/a34\d|a340/.test(t))                                              return 'a340.svg';
    if (/a32[0-9]|a318|a319|a321/.test(t))                                 return 'a320.svg';
    if (/b74[0-9]|747/.test(t))                                            return 'b747.svg';
    if (/b77[0-9]|777/.test(t))                                            return 'b777.svg';
    if (/b78[0-9]|787/.test(t))                                            return 'a330.svg';
    if (/b76[0-9]|767|757/.test(t))                                        return 'b767.svg';
    if (/b73[0-9]|737/.test(t))                                            return 'b737.svg';
    if (/crj|canadair/.test(t))                                            return 'crjx.svg';
    if (/e17[0-9]|e19[0-9]/.test(t))                                       return 'e195.svg';
    if (/erj/.test(t))                                                     return 'erj.svg';
    if (/atr|q400|dash.?8|dh8|twin otter/.test(t))                        return 'dh8a.svg';
    if (/learjet/.test(t))                                                 return 'learjet.svg';
    if (/md.?11|l-1011/.test(t))                                           return 'md11.svg';
    if (/f-15|f15/.test(t))                                                return 'f15.svg';
    if (/f-16|f16|f-14|f-22|f-35|mirage|typhoon|rafale|spitfire|sukhoi|mig/.test(t)) return 'f5.svg';
    if (/gulfstream|citation|phenom|vision jet|pc.?24/.test(t))            return 'glf5.svg';
    if (/cessna|piper|cirrus|diamond|pilatus|vans|britten/.test(t))        return 'cessna.svg';

    return 'c0.svg'; // 最終 fallback
  }
};

// 頁面一載入就開始 fetch
AircraftIconDB.load();


// ─────────────────────────────────────────────────────────────
// 2. 建構 icon URL
// ─────────────────────────────────────────────────────────────
const ICONS_BASE_PATH = '/icons/';

function getIconUrl(aircraftType) {
  return ICONS_BASE_PATH + AircraftIconDB.resolve(aircraftType);
}


// ─────────────────────────────────────────────────────────────
// 3. Leaflet 地圖 icon（取代原本的 getAtcBlip）
//
//    新版函數簽名與舊版相容：
//      getAtcBlip(heading, size, colorOverride, aircraftType)
//    舊版只有 (heading, size, color)，第4個參數是新增的
// ─────────────────────────────────────────────────────────────
function getAtcBlip(heading = 0, size = 32, _color = null, aircraftType = '') {
  const iconUrl = getIconUrl(aircraftType);
  const deg = Number(heading || 0);

  const html = `
    <div style="width:${size}px;height:${size}px;filter:drop-shadow(0 0 4px rgba(255,255,255,0.55));">
      <img
        src="${iconUrl}"
        width="${size}" height="${size}"
        style="transform:rotate(${deg}deg);transform-origin:center;display:block;"
        onerror="this.src='/icons/c0.svg'"
      />
    </div>`;

  return L.divIcon({
    html,
    className: 'geofs-aircraft-icon',
    iconSize:    [size, size],
    iconAnchor:  [size / 2, size / 2],
    popupAnchor: [0, -(size / 2)],
  });
}


// ─────────────────────────────────────────────────────────────
// 4. 側邊列表小圖示（取代原本的 getListBlipHtml）
//
//    舊版：getListBlipHtml(heading)
//    新版：getListBlipHtml(heading, aircraftType)   ← 向下相容
// ─────────────────────────────────────────────────────────────
function getListBlipHtml(heading = 0, aircraftType = '') {
  const iconUrl = getIconUrl(aircraftType);
  const deg = Number(heading || 0);

  return `<span style="display:inline-block;width:20px;height:20px;margin-right:6px;
            vertical-align:middle;flex-shrink:0;
            filter:drop-shadow(0 0 3px rgba(255,255,255,0.45));">
    <img src="${iconUrl}" width="20" height="20"
      style="transform:rotate(${deg}deg);transform-origin:center;display:block;"
      onerror="this.src='/icons/c0.svg'"
    />
  </span>`;
}


// ─────────────────────────────────────────────────────────────
// 5. Preload 所有 icon（避免飛機出現時才延遲載入）
// ─────────────────────────────────────────────────────────────
AircraftIconDB.load().then(() => {
  const unique = [...new Set(Object.values(AircraftIconDB._map))];
  unique.forEach(icon => { const i = new Image(); i.src = ICONS_BASE_PATH + icon; });
  console.log(`[AircraftIcons] Preloaded ${unique.length} icons`);
});