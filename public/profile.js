const ProfileApp = (() => {
  const DOM = {
    loading: document.getElementById('profileLoading'),
    error: document.getElementById('profileError'),
    errorText: document.getElementById('profileErrorText'),
    content: document.getElementById('profileContent'),
    banner: document.getElementById('profileBanner'),
    bannerBg: document.querySelector('.profile-banner-bg'),
    avatar: document.getElementById('profileAvatar'),
    status: document.getElementById('profileStatus'),
    statusTooltip: document.getElementById('profileStatusTooltip'),
    displayName: document.getElementById('profileDisplayName'),
    username: document.getElementById('profileUsername'),
    joined: document.getElementById('profileJoined'),
    statsGrid: document.getElementById('profileStatsGrid'),
    heatmapCanvas: document.getElementById('profileHeatmapCanvas'),
    heatmapYear: document.getElementById('heatmapYear'),
    heatmapTotal: document.getElementById('heatmapTotal'),
    heatmapPrevYear: document.getElementById('heatmapPrevYear'),
    heatmapNextYear: document.getElementById('heatmapNextYear'),
    heatmapTooltip: document.getElementById('heatmapTooltip'),
    mapContainer: document.getElementById('profileWorldMap'),
    mapStats: document.getElementById('profileMapStats'),
    flightsList: document.getElementById('profileFlightsList'),
    navActions: document.getElementById('profileNavActions'),
    featuredMedal:  document.getElementById('profileFeaturedMedal'),   // 新增
    medalInventory: document.getElementById('profileMedalInventory'),
  };

  const state = {
    discordId: null,
    user: null,
    stats: null,
    flights: [],
    airports: null,
    heatmapYear: new Date().getFullYear(),
    minYear: new Date().getFullYear(),
    maxYear: new Date().getFullYear(),
    heatmapSeries: {},
    map: null,
    tileLayer: null,
    airportMarkers: [],
    medals: [] 
  };

  const DEFAULT_AVATAR = 'https://i.ibb.co/Tg6mDts/default-avatar.png';
  const PROFILE_THEME_KEY = 'cfg_profile_theme';
  const PROFILE_BANNER_IMAGE_KEY = 'cfg_banner_image';
  const LOCAL_AIRPORTS_URL = '/airports.json';
  const REMOTE_AIRPORTS_URL = 'https://raw.githubusercontent.com/mwgg/Airports/refs/heads/master/airports.json';
  const LEAFLET_ASSET_BASE = 'https://unpkg.com/leaflet@1.9.4/dist/images';
  const STATUS_ONLINE_THRESHOLD_MS = 20 * 60 * 1000;

  function getQueryParam(name) {
    return new URLSearchParams(window.location.search).get(name);
  }

  function configureLeafletIcons() {
    if (typeof L === 'undefined' || !L.Icon || !L.Icon.Default) return;
    L.Icon.Default.mergeOptions({
      iconUrl: `${LEAFLET_ASSET_BASE}/marker-icon.png`,
      iconRetinaUrl: `${LEAFLET_ASSET_BASE}/marker-icon-2x.png`,
      shadowUrl: `${LEAFLET_ASSET_BASE}/marker-shadow.png`
    });
  }

  function formatDate(value) {
    if (!value) return '—';
    const date = new Date(value);
    return date.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
  }

  function formatDuration(seconds) {
    if (!Number.isFinite(seconds) || seconds <= 0) return '0m';
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.round((seconds % 3600) / 60);
    return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
  }

  function formatNumber(value) {
    return value == null || Number.isNaN(value)
      ? '0'
      : value.toLocaleString();
  }

  function formatDistance(value) {
    if (!Number.isFinite(value) || value <= 0) return '0 nm';
    return `${Math.round(value).toLocaleString()} nm`;
  }

  function formatSpeed(value) {
    if (!Number.isFinite(value) || value <= 0) return '0 kt';
    return `${Math.round(value).toLocaleString()} kt`;
  }

  function setVisible(element, visible) {
    element.style.display = visible ? '' : 'none';
  }

  function showError(message) {
    DOM.loading.style.display = 'none';
    DOM.content.style.display = 'none';
    DOM.error.style.display = '';
    DOM.errorText.textContent = message || 'Pilot not found';
  }

  function showContent() {
    DOM.loading.style.display = 'none';
    DOM.error.style.display = 'none';
    DOM.content.style.display = '';
  }

  async function apiGet(url) {
    const res = await fetch(url, { credentials: 'same-origin' });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`${res.status} ${res.statusText}: ${text}`);
    }
    return res.json();
  }

  async function loadCurrentUser() {
    try {
      return await apiGet('/api/user/me');
    } catch {
      return null;
    }
  }

  async function loadPublicUser(discordId) {
    if (!discordId) return null;
    return apiGet(`/api/users/${encodeURIComponent(discordId)}`);
  }

  async function loadPublicUserByGeofsId(geofsUserId) {
    if (!geofsUserId) return null;
    return apiGet(`/api/users/geofs/${encodeURIComponent(geofsUserId)}`);
  }

  async function loadStats(discordId) {
    return apiGet(`/api/flights/stats/${encodeURIComponent(discordId)}`);
  }

  async function loadFlightsByGeofsId(geofsUserId, limit = 12) {
    if (!geofsUserId) return [];
    return apiGet(`/api/flights/geofs/${encodeURIComponent(geofsUserId)}?limit=${limit}`);
  }

  function computeStatsFromFlights(flights) {
    const stats = {
      totalFlights: 0,
      totalDistanceNm: 0,
      totalDuration: 0,
      maxAlt: 0,
      maxSpeed: 0
    };
    flights.forEach(flight => {
      stats.totalFlights += 1;
      stats.totalDistanceNm += Number(flight.distanceNm || 0);
      stats.totalDuration += Number(flight.duration || 0);
      stats.maxAlt = Math.max(stats.maxAlt, Number(flight.maxAlt || 0));
      stats.maxSpeed = Math.max(stats.maxSpeed, Number(flight.maxSpeed || 0));
    });
    return stats;
  }

  async function loadFlights(discordId, limit = 12) {
    return apiGet(`/api/flights/user/${encodeURIComponent(discordId)}?limit=${limit}`);
  }

  async function loadMedals(discordId) {
    if (!discordId) return [];
    try {
      const payload = await apiGet(`/api/users/${encodeURIComponent(discordId)}/medals`);
      return Array.isArray(payload?.medals) ? payload.medals : [];
    } catch (error) {
      console.warn('Medals failed to load:', error);
      return [];
    }
  }

  async function setFeaturedMedal(medalId) {
    const response = await fetch('/api/user/medals/featured', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ medalId })
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`${response.status} ${response.statusText}: ${text}`);
    }
    return response.json();
  }

  function resolveAvatar(user) {
    if (user?.photos?.length) {
      return user.photos[0];
    }
    if (user?.username) {
      const hash = Array.from(user.username).reduce((acc, char) => acc + char.charCodeAt(0), 0);
      return `https://api.dicebear.com/6.x/gridy/svg?seed=${encodeURIComponent(user.username)}&backgroundColor=080d12`;
    }
    return DEFAULT_AVATAR;
  }

  function getSavedProfileCustomizations() {
    return {
      avatarUrl: localStorage.getItem('cfg_avatar') || '',
      bannerCss: localStorage.getItem('cfg_banner') || '',
      bannerImage: localStorage.getItem(PROFILE_BANNER_IMAGE_KEY) || '',
      theme: localStorage.getItem(PROFILE_THEME_KEY) || 'default'
    };
  }

  function applyProfileTheme(theme) {
    const themes = ['default', 'discord', 'cyber', 'emerald'];
    themes.forEach(name => document.body.classList.remove(`theme-${name}`));
    document.body.classList.add(`theme-${theme || 'default'}`);
  }

  function applyProfileCustomizations(isOwnProfile) {
    const custom = getSavedProfileCustomizations();
    if (!isOwnProfile) {
      applyProfileTheme('default');
      return;
    }

    if (custom.avatarUrl && custom.avatarUrl.trim()) {
      DOM.avatar.src = custom.avatarUrl.trim();
    }

    if (DOM.bannerBg) {
      if (custom.bannerImage) {
        DOM.bannerBg.style.background = `url('${custom.bannerImage}') center / cover no-repeat`;
      } else if (custom.bannerCss) {
        DOM.bannerBg.style.background = custom.bannerCss;
      } else {
        DOM.bannerBg.style.background = '';
      }
    }

    applyProfileTheme(custom.theme);
  }

  function openProfileSettingsModal() {
    const custom = getSavedProfileCustomizations();
    const modalId = 'profile-settings-modal';
    const existing = document.getElementById(modalId);
    if (existing) existing.remove();

    const modal = document.createElement('div');
    modal.id = modalId;
    modal.className = 'profile-settings-modal';
    modal.innerHTML = `
      <div class="profile-settings-card">
        <div class="profile-settings-header">
          <div>
            <div class="profile-settings-title">Profile Settings</div>
            <div class="profile-settings-subtitle">Customize your banner, theme and avatar.</div>
          </div>
          <button type="button" class="profile-settings-close" aria-label="Close settings">✕</button>
        </div>

        <div class="profile-settings-group">
          <label>Upload banner image</label>
          <input type="file" id="set-banner-upload" accept="image/*" class="profile-settings-input" />
          <div class="profile-settings-note">Max 1MB. The uploaded image will be saved locally and shown as your profile banner.</div>
        </div>

        <div class="profile-settings-group">
          <label>Banner image / URL</label>
          <input type="text" id="set-banner-image" value="${custom.bannerImage || ''}" placeholder="https://... or choose upload" class="profile-settings-input" />
        </div>

        <div class="profile-settings-group">
          <label>Profile banner accent</label>
          <select id="set-banner-css" class="profile-settings-input">
            <option value="linear-gradient(135deg, #0f2027, #203a43, #2c5364)" ${custom.bannerCss.includes('#0f2027') ? 'selected' : ''}>Deep Ocean</option>
            <option value="linear-gradient(135deg, #833ab4, #fd1d1d, #fcb045)" ${custom.bannerCss.includes('#833ab4') ? 'selected' : ''}>Sunset Glow</option>
            <option value="linear-gradient(135deg, #00cfff, #005f73)" ${custom.bannerCss.includes('#00cfff') ? 'selected' : ''}>Cyber Neon</option>
            <option value="linear-gradient(135deg, #11998e, #38ef7d)" ${custom.bannerCss.includes('#11998e') ? 'selected' : ''}>Emerald Flight</option>
            <option value="#1a2634" ${custom.bannerCss === '#1a2634' ? 'selected' : ''}>Minimalist Dark</option>
          </select>
        </div>

        <div class="profile-settings-group">
          <label>Profile theme style</label>
          <select id="set-theme" class="profile-settings-input">
            <option value="default" ${custom.theme === 'default' ? 'selected' : ''}>Default</option>
            <option value="discord" ${custom.theme === 'discord' ? 'selected' : ''}>Discord Gloss</option>
            <option value="cyber" ${custom.theme === 'cyber' ? 'selected' : ''}>Cyber Neon</option>
            <option value="emerald" ${custom.theme === 'emerald' ? 'selected' : ''}>Emerald Pulse</option>
          </select>
        </div>

        <div class="profile-settings-group">
          <label>Upload avatar image</label>
          <input type="file" id="set-avatar-upload" accept="image/*" class="profile-settings-input" />
          <div class="profile-settings-note">Max 1MB. Saved locally as your profile avatar.</div>
        </div>

        <div class="profile-settings-group">
          <label>Avatar image URL <small style="opacity:.5">(or paste a URL)</small></label>
          <input type="text" id="set-avatar" value="" placeholder="https://..." class="profile-settings-input" />
          <div id="set-avatar-status" class="profile-settings-note" style="color:#39d353;display:none;">✓ Custom uploaded avatar is active</div>
        </div>

        <div class="profile-settings-actions">
          <button type="button" id="clear-banner" class="profile-settings-button profile-settings-button-muted">Clear custom banner</button>
          <button type="button" id="clear-avatar" class="profile-settings-button profile-settings-button-muted">Clear avatar</button>
          <button type="button" id="save-profile-settings" class="profile-settings-button profile-settings-button-primary">Save changes</button>
        </div>
      </div>
    `;

    document.body.appendChild(modal);

    // ── Pre-fill avatar field / show status ──────────────────────────────
    const savedAvatarVal = localStorage.getItem('cfg_avatar') || '';
    const avatarUrlInput = modal.querySelector('#set-avatar');
    const avatarStatus = modal.querySelector('#set-avatar-status');
    if (savedAvatarVal.startsWith('data:')) {
      avatarStatus.style.display = '';          // show "uploaded avatar active" note
    } else {
      avatarUrlInput.value = savedAvatarVal;    // pre-fill URL
    }

    modal.querySelector('.profile-settings-close').addEventListener('click', () => modal.remove());

    modal.querySelector('#clear-banner').addEventListener('click', () => {
      const bannerImageInput = modal.querySelector('#set-banner-image');
      bannerImageInput.value = '';
      localStorage.removeItem(PROFILE_BANNER_IMAGE_KEY);
      modal.querySelector('#set-banner-upload').value = '';
    });

    modal.querySelector('#clear-avatar').addEventListener('click', () => {
      avatarUrlInput.value = '';
      avatarStatus.style.display = 'none';
      modal.querySelector('#set-avatar-upload').value = '';
      localStorage.removeItem('cfg_avatar');
      DOM.avatar.src = resolveAvatar(state.user);
    });

    // Banner file upload
    const uploadInput = modal.querySelector('#set-banner-upload');
    const bannerImageInput = modal.querySelector('#set-banner-image');
    uploadInput.addEventListener('change', async (event) => {
      const file = event.target.files?.[0];
      if (!file) return;
      if (file.size > 1024 * 1024) {
        alert('Please upload an image smaller than 1MB.');
        uploadInput.value = '';
        return;
      }
      const reader = new FileReader();
      reader.onload = () => { bannerImageInput.value = reader.result; };
      reader.readAsDataURL(file);
    });

    // Avatar file upload
    const avatarUploadInput = modal.querySelector('#set-avatar-upload');
    avatarUploadInput.addEventListener('change', (event) => {
      const file = event.target.files?.[0];
      if (!file) return;
      if (file.size > 1024 * 1024) {
        alert('Please upload an image smaller than 1MB.');
        avatarUploadInput.value = '';
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        // Store base64 in a temp var; clear URL field to avoid confusion
        avatarUploadInput._base64 = reader.result;
        avatarUrlInput.value = '';
        avatarStatus.style.display = '';
        avatarStatus.textContent = `✓ "${file.name}" ready to save`;
      };
      reader.readAsDataURL(file);
    });

    // Clear pending upload base64 when user types a URL manually
    avatarUrlInput.addEventListener('input', () => {
      if (avatarUrlInput.value.trim()) {
        avatarUploadInput._base64 = null;
        avatarUploadInput.value = '';
        avatarStatus.style.display = 'none';
      }
    });

    modal.querySelector('#save-profile-settings').addEventListener('click', () => {
      // Avatar: prefer uploaded file, fall back to URL field
      const avatarBase64 = avatarUploadInput._base64 || null;
      const avatarUrlValue = avatarUrlInput.value.trim();
      const finalAvatar = avatarBase64 || avatarUrlValue;

      const bannerValue = modal.querySelector('#set-banner-css').value;
      const bannerImageValue = modal.querySelector('#set-banner-image').value.trim();
      const themeValue = modal.querySelector('#set-theme').value;

      if (finalAvatar) {
        localStorage.setItem('cfg_avatar', finalAvatar);
      } else {
        localStorage.removeItem('cfg_avatar');
      }
      localStorage.setItem('cfg_banner', bannerValue);
      localStorage.setItem(PROFILE_THEME_KEY, themeValue);
      if (bannerImageValue) {
        localStorage.setItem(PROFILE_BANNER_IMAGE_KEY, bannerImageValue);
      } else {
        localStorage.removeItem(PROFILE_BANNER_IMAGE_KEY);
      }

      modal.remove();
      applyProfileCustomizations(true);
      alert('Profile settings updated successfully!');
    });
  }

  function handleShareProfile() {
    const shareUrl = window.location.href;
    if (navigator.share) {
      navigator.share({ title: 'Share profile', url: shareUrl }).catch(() => {
        navigator.clipboard.writeText(shareUrl).then(() => alert('Profile link copied to clipboard!'));
      });
      return;
    }
    if (navigator.clipboard) {
      navigator.clipboard.writeText(shareUrl).then(() => alert('Profile link copied to clipboard!'), () => prompt('Copy this profile URL:', shareUrl));
    } else {
      prompt('Copy this profile URL:', shareUrl);
    }
  }

  function renderStats(stats, flights) {
    const totalFlights = stats.totalFlights || 0;
    const totalDistance = stats.totalDistanceNm || 0;
    const totalDuration = stats.totalDuration || 0;
    const maxAlt = stats.maxAlt || 0;
    const maxSpeed = stats.maxSpeed || 0;
    const avgDuration = totalFlights ? Math.round(totalDuration / totalFlights) : 0;

    const cards = [
      { icon: '🛩️', value: formatNumber(totalFlights), label: 'Flights', accent: 'green' },
      { icon: '⏱️', value: formatDuration(totalDuration), label: 'Total time', accent: 'gold' },
      { icon: '🧭', value: formatDistance(totalDistance), label: 'Distance', accent: 'purple' },
      { icon: '🌡️', value: formatNumber(maxAlt), label: 'Max altitude', accent: 'orange' },
      { icon: '💨', value: formatSpeed(maxSpeed), label: 'Top speed', accent: 'red' },
      { icon: '📈', value: formatDuration(avgDuration), label: 'Avg flight', accent: 'green' }
    ];

    DOM.statsGrid.innerHTML = cards.map(card => `
      <div class="profile-stat-card" data-accent="${card.accent}">
        <div class="profile-stat-icon">${card.icon}</div>
        <div class="profile-stat-value">${card.value}</div>
        <div class="profile-stat-label">${card.label}</div>
      </div>
    `).join('');
  }

  function getHeatmapDatesForYear(year) {
    const start = new Date(Date.UTC(year, 0, 1));
    const end = new Date(Date.UTC(year + 1, 0, 1));
    const dates = [];
    let current = new Date(start);
    while (current < end) {
      dates.push(new Date(current));
      current.setUTCDate(current.getUTCDate() + 1);
    }
    return dates;
  }

  function buildHeatmapSeries(flights) {
    const series = {};
    flights.forEach(flight => {
      if (!flight.startTime) return;
      const date = new Date(Number(flight.startTime));
      const key = date.toISOString().slice(0, 10);
      series[key] = (series[key] || 0) + 1;
    });
    return series;
  }

  function formatHeatmapCount(count) {
    if (!count) return 'No flights';
    return `${count} flight${count === 1 ? '' : 's'}`;
  }

  function renderHeatmap(year) {
    const canvas = DOM.heatmapCanvas;
    const ctx = canvas.getContext('2d');
    const data = state.heatmapSeries;
    if (!ctx) return;

    const dates = getHeatmapDatesForYear(year);
    const cols = Math.ceil(dates.length / 7);
    const cell = 12;
    const gap = 4;
    const margin = 8;
    const leftPaddingCols = 1; // shift the first data column slightly to the right
    const width = (cols + leftPaddingCols) * (cell + gap) + margin * 2;
    const height = 7 * (cell + gap) + margin * 2;

    canvas.width = width * window.devicePixelRatio;
    canvas.height = height * window.devicePixelRatio;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    ctx.setTransform(window.devicePixelRatio, 0, 0, window.devicePixelRatio, 0, 0);
    ctx.clearRect(0, 0, width, height);

    const yearKeys = dates.map(date => date.toISOString().slice(0, 10));
    const counts = yearKeys.map(key => data[key] || 0);
    const maxCount = Math.max(1, ...counts);
    const palette = ['#07121c', '#09213d', '#0c3d76', '#0a85d4', '#00cfff'];

    dates.forEach((date, index) => {
      const col = Math.floor(index / 7);
      const row = index % 7;
      const count = data[date.toISOString().slice(0, 10)] || 0;
      const intensity = count === 0 ? 0 : Math.min(palette.length - 1, Math.ceil((count / maxCount) * (palette.length - 1)));
      const color = palette[intensity];
      const x = margin + leftPaddingCols * (cell + gap) + col * (cell + gap);
      const y = margin + row * (cell + gap);

      ctx.fillStyle = color;
      ctx.fillRect(x, y, cell, cell);
      ctx.strokeStyle = 'rgba(0, 207, 255, 0.08)';
      ctx.strokeRect(x, y, cell, cell);
    });

    ctx.fillStyle = 'rgba(255,255,255,0.04)';
    ctx.fillRect(margin, margin, leftPaddingCols * (cell + gap), height - margin * 2);

    DOM.heatmapYear.textContent = String(year);
    const totalForYear = counts.reduce((sum, value) => sum + value, 0);
    DOM.heatmapTotal.innerHTML = `<strong>${totalForYear}</strong> flights in ${year}`;
  }

  function handleHeatmapHover(event) {
    const canvas = DOM.heatmapCanvas;
    const rect = canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    const cell = 12;
    const gap = 4;
    const margin = 8;
    const leftPaddingCols = 1;
    const col = Math.floor((x - margin - leftPaddingCols * (cell + gap)) / (cell + gap));
    const row = Math.floor((y - margin) / (cell + gap));

    if (col < 0 || row < 0) {
      DOM.heatmapTooltip.classList.remove('visible');
      return;
    }

    const dates = getHeatmapDatesForYear(state.heatmapYear);
    const index = col * 7 + row;
    const date = dates[index];
    if (!date) {
      DOM.heatmapTooltip.classList.remove('visible');
      return;
    }

    const key = date.toISOString().slice(0, 10);
    const count = state.heatmapSeries[key] || 0;
    DOM.heatmapTooltip.innerHTML = `<strong>${date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</strong><br>${formatHeatmapCount(count)}`;
    DOM.heatmapTooltip.style.top = `${event.clientY + 14}px`;
    DOM.heatmapTooltip.style.left = `${event.clientX + 14}px`;
    DOM.heatmapTooltip.classList.add('visible');
  }

  function hideHeatmapTooltip() {
    DOM.heatmapTooltip.classList.remove('visible');
  }

  function sortFlights(flights) {
    return flights.slice().sort((a, b) => Number(b.startTime || 0) - Number(a.startTime || 0));
  }

  function renderFlights(flights) {
    DOM.flightsList.innerHTML = '';
    if (!flights || !flights.length) {
      DOM.flightsList.innerHTML = '<div class="profile-flight-card" style="border-color: rgba(255,255,255,0.08); color: var(--pf-text-muted);">No recent flights available.</div>';
      return;
    }

    const cards = sortFlights(flights).slice(0, 8).map(flight => {
      const departure = flight.departure || 'N/A';
      const arrival = flight.arrival || 'N/A';
      const duration = formatDuration(flight.duration || 0);
      const distance = formatDistance(flight.distanceNm || 0);
      const status = String(flight.status || 'completed').toLowerCase();
      const quality = String(flight.landingQuality || '').toLowerCase();
      const qualityLabel = flight.landingQuality ? `<span class="landing-badge ${quality}">${flight.landingQuality}</span>` : '';
      const callsign = flight.callsign || flight.flightNo || 'Unknown';
      const start = flight.startTime ? new Date(Number(flight.startTime)).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '—';

      return `
        <div class="profile-flight-card">
          <div>
            <div class="profile-flight-callsign">${callsign}</div>
            <div class="profile-flight-route">
              <span class="airport">${departure}</span>
              <span class="arrow">→</span>
              <span class="airport">${arrival}</span>
            </div>
          </div>
          <div class="profile-flight-meta">
            <span title="Departure date">${start}</span>
            <span title="Duration">${duration}</span>
            <span title="Distance">${distance}</span>
            <span class="profile-flight-status ${status}">${status.toUpperCase()}</span>
            ${qualityLabel}
          </div>
        </div>
      `;
    });

    DOM.flightsList.innerHTML = cards.join('');
  }

  function renderHeader(user, stats, flights) {
    DOM.avatar.src = resolveAvatar(user);
    DOM.displayName.textContent = user.displayName || user.username || 'Pilot';
    DOM.username.innerHTML = `@<span class="at">${user.username || 'unknown'}</span>`;
    DOM.joined.textContent = `Joined ${formatDate(user.createdAt)}`;

    const latestFlight = sortFlights(flights)[0];
    const lastSeenTime = latestFlight ? Number(latestFlight.endTime || latestFlight.startTime || 0) : 0;
    const now = Date.now();
    const recentlyActive = lastSeenTime && now - lastSeenTime < STATUS_ONLINE_THRESHOLD_MS;
    DOM.status.classList.toggle('online', recentlyActive);
    DOM.status.classList.toggle('offline', !recentlyActive);

    const statusLabel = recentlyActive ? 'Online' : 'Offline';
    const lastSeenLabel = latestFlight
      ? `${formatDuration(Math.round((now - lastSeenTime) / 1000))} since last flight`
      : 'No flight activity yet';

    DOM.statusTooltip.innerHTML = `
      <div class="profile-status-tooltip-title">
        <span class="dot ${recentlyActive ? 'online' : 'offline'}"></span>
        ${statusLabel}
      </div>
      <div class="profile-status-tooltip-row"><span class="label">Activity</span><span class="value">${lastSeenLabel}</span></div>
    `;
  }

  function createMedalCard(medal, isOwnProfile) {
    const card = document.createElement('div');
    card.className = `profile-medal-card${medal.featured ? ' featured' : ''}`;

    const icon = document.createElement('img');
    icon.className = 'profile-medal-icon';
    icon.src = medal.iconUrl || '/medals/time-gray.png';
    icon.alt = medal.name || 'Medal';
    icon.loading = 'lazy';

    const body = document.createElement('div');
    body.className = 'profile-medal-body';

    const title = document.createElement('div');
    title.className = 'profile-medal-title';
    title.textContent = medal.name || 'Medal';

    const description = document.createElement('div');
    description.className = 'profile-medal-description';
    description.textContent = medal.description || 'Unlocked medal';

    body.append(title, description);
    card.append(icon, body);

    if (medal.featured) {
      const badge = document.createElement('span');
      badge.className = 'profile-medal-featured-badge';
      badge.textContent = 'Featured';
      card.appendChild(badge);
    } else if (isOwnProfile) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'profile-medal-feature-button';
      button.textContent = 'Feature';
      button.addEventListener('click', async () => {
        button.disabled = true;
        try {
          const payload = await setFeaturedMedal(medal.medalId);
          state.medals = Array.isArray(payload?.medals) ? payload.medals : state.medals;
          renderFeaturedMedal(state.medals);
          renderMedalInventory(state.medals, true);
        } catch (error) {
          console.error(error);
          alert('Failed to update featured medal.');
          button.disabled = false;
        }
      });
      card.appendChild(button);
    }

    return card;
  }

  function renderFeaturedMedal(medals) {
    if (!DOM.featuredMedal) return;
    DOM.featuredMedal.innerHTML = '';
    const featured = (medals || []).find(medal => medal.featured);
    if (!featured) return;

    const wrapper = document.createElement('div');
    wrapper.className = 'profile-featured-medal';

    const icon = document.createElement('img');
    icon.src = featured.iconUrl || '/medals/time-gray.png';
    icon.alt = featured.name || 'Featured medal';
    icon.loading = 'lazy';

    const label = document.createElement('span');
    label.textContent = featured.name || 'Featured medal';

    wrapper.append(icon, label);
    DOM.featuredMedal.appendChild(wrapper);
  }

  function renderMedalInventory(medals, isOwnProfile) {
    if (!DOM.medalInventory) return;
    DOM.medalInventory.innerHTML = '';

    const earned = Array.isArray(medals) ? medals : [];
    if (!earned.length) {
      const empty = document.createElement('div');
      empty.className = 'profile-medal-empty';
      empty.textContent = 'No medals earned yet.';
      DOM.medalInventory.appendChild(empty);
      return;
    }

    const grid = document.createElement('div');
    grid.className = 'profile-medal-grid';
    earned.forEach(medal => grid.appendChild(createMedalCard(medal, isOwnProfile)));
    DOM.medalInventory.appendChild(grid);

    if (isOwnProfile && earned.some(medal => medal.featured)) {
      const clearButton = document.createElement('button');
      clearButton.type = 'button';
      clearButton.className = 'profile-medal-clear-button';
      clearButton.textContent = 'Clear featured medal';
      clearButton.addEventListener('click', async () => {
        clearButton.disabled = true;
        try {
          const payload = await setFeaturedMedal('none');
          state.medals = Array.isArray(payload?.medals) ? payload.medals : state.medals;
          renderFeaturedMedal(state.medals);
          renderMedalInventory(state.medals, true);
        } catch (error) {
          console.error(error);
          alert('Failed to update featured medal.');
          clearButton.disabled = false;
        }
      });
      DOM.medalInventory.appendChild(clearButton);
    }
  }

function renderProfileHeatmap(flights) {
  // 尋找你的 Heatmap 包裹容器（請確認你 HTML 中放網格的 div 的 id 或 class 叫什麼，這裡假設是 #profileHeatmapGrid）
  const container = document.getElementById('profileHeatmapGrid') || document.querySelector('.profile-heatmap-wrap');
  if (!container) return;

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  
  // 計算起點：51週整 + 本週已過天數 = 總顯示天數，並對齊到最左側星期日
  const msPerDay = 24 * 60 * 60 * 1000;
  const totalDays = 51 * 7 + (today.getDay() + 1);
  const startDate = new Date(today.getTime() - (totalDays - 1) * msPerDay);

  // 統計每日飛行次數 key: "YYYY-MM-DD"
  const dayCounts = {};
  flights.forEach(f => {
    if (!f.startTime) return;
    const d = new Date(f.startTime);
    const key = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
    dayCounts[key] = (dayCounts[key] || 0) + 1;
  });

  const cellSize = 11;
  const cellGap = 3;
  const step = cellSize + cellGap;
  const W = 52 * step + 35;
  const H = 7 * step + 20;

  let rectsHtml = '';
  let monthLabels = [];
  let lastMonth = -1;

  // 星期標籤
  const dayLabels = `
    <text x="0" y="${20 + step * 1.75}" fill="#8b949e" font-size="9" font-family="sans-serif">Mon</text>
    <text x="0" y="${20 + step * 3.75}" fill="#8b949e" font-size="9" font-family="sans-serif">Wed</text>
    <text x="0" y="${20 + step * 5.75}" fill="#8b949e" font-size="9" font-family="sans-serif">Fri</text>
  `;

  for (let col = 0; col < 52; col++) {
    for (let row = 0; row < 7; row++) {
      const dayOffset = (col * 7) + row;
      if (dayOffset >= totalDays) continue;

      const currentDate = new Date(startDate.getTime() + dayOffset * msPerDay);
      
      // 每月初繪製月份標籤
      if (row === 0 && currentDate.getMonth() !== lastMonth && col < 50) {
        monthLabels.push(`<text x="${30 + col * step}" y="10" fill="#8b949e" font-size="9" font-family="sans-serif">${currentDate.toLocaleString('en', { month: 'short' })}</text>`);
        lastMonth = currentDate.getMonth();
      }

      const key = `${currentDate.getFullYear()}-${String(currentDate.getMonth()+1).padStart(2,'0')}-${String(currentDate.getDate()).padStart(2,'0')}`;
      const count = dayCounts[key] || 0;

      // 根據次數對齊你 HTML 內部的 GitHub 綠色色階
      let fill = '#161b22'; // 0次 (GitHub 暗色空白格)
      if (count === 1) fill = '#0e4429';       // 淺綠
      else if (count === 2) fill = '#006d32';  // 中綠
      else if (count === 3) fill = '#26a641';  // 亮綠
      else if (count >= 4) fill = '#39d353';   // 最亮綠

      const x = 30 + col * step;
      const y = 15 + row * step;
      const dateStr = currentDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

      rectsHtml += `
        <rect x="${x}" y="${y}" width="${cellSize}" height="${cellSize}" rx="2" fill="${fill}" class="heatmap-cell">
          <title>${count} flights on ${dateStr}</title>
        </rect>`;
    }
  }

  // 渲染進網格，加上橫向捲動防止手機破版
  container.innerHTML = `
    <div style="overflow-x:auto; padding-bottom:8px; scrollbar-width:thin;">
      <svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" style="min-width:${W}px;" xmlns="http://www.w3.org/2000/svg">
        ${dayLabels}
        ${monthLabels.join('')}
        ${rectsHtml}
      </svg>
    </div>
  `;
}
// ── 套用自訂的 Profile 設定 ───────────────────────────────────────────
function applyCustomProfileSettings() {
  // 假設你的系統能判斷這是否是「玩家看自己」的頁面
  const isMyOwnProfile = true; 

  if (isMyOwnProfile) {
    const savedAvatar = localStorage.getItem('cfg_avatar');
    const savedBanner = localStorage.getItem('cfg_banner');
    const savedAchievement = localStorage.getItem('cfg_featured_achievement');

    // 1. 套用自訂頭像 (尋找你的大頭貼 img 標籤)
    if (savedAvatar) {
      const avatarImg = document.getElementById('profileAvatar') || document.querySelector('.profile-avatar') || document.getElementById('pilotAvatar');
      if (avatarImg) avatarImg.src = savedAvatar;
    }

    // 2. 套用自訂 Banner 橫幅背景
    if (savedBanner) {
      const bannerDiv = document.getElementById('profileBanner') || document.querySelector('.profile-banner') || document.querySelector('.profile-header');
      if (bannerDiv) bannerDiv.style.background = savedBanner;
    }

    // 3. 渲染精選成就 Badge (放至名字下方)
    if (savedAchievement && savedAchievement !== 'none') {
      const nameContainer = document.getElementById('profileName') || document.querySelector('.profile-name') || document.querySelector('.profile-pilot-name');
      if (nameContainer && !document.getElementById('featured-badge')) {
        const badge = document.createElement('div');
        badge.id = 'featured-badge';
        badge.style = `
          display: inline-flex; align-items: center; 
          background: rgba(0, 207, 255, 0.15); border: 1px solid rgba(0, 207, 255, 0.3); 
          padding: 4px 8px; border-radius: 4px; font-size: 11px; color: #00cfff; 
          margin-top: 6px; font-weight: 600; width: fit-content;
        `;
        badge.innerText = savedAchievement;
        nameContainer.after(badge);
      }
    }
  }
}

// 在你獲取到飛行數據並渲染畫面的主邏輯中呼叫它們：
// applyCustomProfileSettings();
// renderProfileHeatmap(flightsData);
  async function loadAirportsDatabase() {
    if (state.airports) return state.airports;
    const sources = [LOCAL_AIRPORTS_URL, REMOTE_AIRPORTS_URL];
    let raw = null;

    for (const source of sources) {
      try {
        const response = await fetch(source);
        if (!response.ok) throw new Error(`Failed to load airport database from ${source}`);
        const payload = await response.json();
        if (payload && typeof payload === 'object') {
          raw = payload;
          break;
        }
      } catch (err) {
        console.warn('Airport database load failed:', err.message || err, 'source:', source);
      }
    }

    if (!raw || typeof raw !== 'object') {
      console.error('Unable to load airport database from any source');
      state.airports = { icaoMap: new Map(), iataMap: new Map() };
      return state.airports;
    }

    const icaoMap = new Map();
    const iataMap = new Map();
    Object.entries(raw).forEach(([icao, entry]) => {
      const meta = {
        icao: icao.toUpperCase(),
        iata: String(entry.iata || '').toUpperCase() || null,
        name: entry.name || '',
        lat: Number(entry.lat || entry.latitude_deg || 0),
        lon: Number(entry.lon || entry.longitude_deg || 0)
      };
      icaoMap.set(meta.icao, meta);
      if (meta.iata) iataMap.set(meta.iata, meta);
    });
    state.airports = { icaoMap, iataMap };
    return state.airports;
  }

  function normalizeAirportLookupCodes(code) {
    if (!code) return [];
    const normalized = String(code).trim().toUpperCase();
    if (!normalized) return [];

    const results = new Set();
    results.add(normalized);
    results.add(normalized.slice(0, 4));

    const parts = normalized.split(/[\/\-]/).filter(Boolean);
    parts.forEach(part => {
      if (part) {
        results.add(part);
        results.add(part.slice(0, 4));
      }
    });

    if (normalized.length >= 4) {
      results.add(normalized.slice(-4));
    }

    return [...results].filter(Boolean);
  }

  function resolveAirport(code, airportDb) {
    if (!code) return null;
    const candidates = normalizeAirportLookupCodes(code);
    for (const candidate of candidates) {
      if (!candidate) continue;
      if (airportDb.icaoMap.has(candidate)) return airportDb.icaoMap.get(candidate);
      if (airportDb.iataMap.has(candidate)) return airportDb.iataMap.get(candidate);
    }

    for (const candidate of candidates) {
      if (!candidate) continue;
      for (const airport of airportDb.icaoMap.values()) {
        if (airport.icao === candidate || airport.icao.endsWith('/' + candidate) || airport.icao.endsWith(candidate) || airport.iata === candidate) {
          return airport;
        }
      }
    }

    return null;
  }

  function updateMap(flights, airportDb) {
    if (!state.map) {
      state.map = L.map(DOM.mapContainer, {
        worldCopyJump: true,
        zoomControl: false
      }).setView([20, 0], 2);
      state.tileLayer = L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
        attribution: '© CartoDB'
      }).addTo(state.map);
    }

    state.airportMarkers.forEach(marker => state.map.removeLayer(marker));
    state.airportMarkers = [];

    const visited = new Map();
    flights.forEach(flight => {
      normalizeAirportLookupCodes(flight.departure).forEach(code => {
        if (code) visited.set(code, code);
      });
      normalizeAirportLookupCodes(flight.arrival).forEach(code => {
        if (code) visited.set(code, code);
      });
    });

    const airportMeta = [];
    visited.forEach(code => {
      const apt = resolveAirport(code, airportDb);
      if (apt && Number.isFinite(apt.lat) && Number.isFinite(apt.lon)) {
        airportMeta.push(apt);
      }
    });

    if (airportMeta.length) {
      const airportDotIcon = L.divIcon({
        html: '<div style="width:10px;height:10px;background:#00cfff;border:2px solid rgba(255,255,255,0.9);border-radius:50%;box-shadow:0 0 10px rgba(0, 207, 255, 0.35);"></div>',
        className: '',
        iconSize: [14, 14],
        iconAnchor: [7, 7],
        popupAnchor: [0, -8]
      });

      airportMeta.forEach(apt => {
        const marker = L.marker([apt.lat, apt.lon], {
          icon: airportDotIcon,
          title: apt.icao || apt.iata || 'Airport'
        }).addTo(state.map);
        marker.bindPopup(`<div class="airport-visited-popup"><div class="code">${apt.iata || apt.icao}</div><div class="name">${apt.name}</div></div>`);
        state.airportMarkers.push(marker);
      });
      const bounds = L.latLngBounds(airportMeta.map(apt => [apt.lat, apt.lon]));
      state.map.fitBounds(bounds.pad(0.35), { animate: true, duration: 0.4, maxZoom: 6 });
    } else {
      state.map.setView([20, 0], 2);
    }

    DOM.mapStats.innerHTML = `
      <div class="profile-map-stat"><span class="value">${airportMeta.length}</span> airports visited</div>
      <div class="profile-map-stat"><span class="value">${flights.length}</span> flights tracked</div>
    `;
  }

  function renderNavActions(viewer, targetDiscordId) {
    DOM.navActions.innerHTML = '';

    const shareButton = document.createElement('button');
    shareButton.type = 'button';
    shareButton.className = 'profile-nav-action profile-nav-action-share';
    shareButton.textContent = 'Share profile';
    shareButton.addEventListener('click', handleShareProfile);
    DOM.navActions.appendChild(shareButton);

    if (viewer?.authenticated && viewer.user?.discordId === targetDiscordId) {
      const editButton = document.createElement('button');
      editButton.type = 'button';
      editButton.className = 'profile-nav-action';
      editButton.textContent = 'Edit profile';
      editButton.addEventListener('click', openProfileSettingsModal);
      DOM.navActions.appendChild(editButton);
    }
  }

  async function init() {
    state.discordId = getQueryParam('discordId');
    const geofsUserId = getQueryParam('geofsUserId');
    if (!state.discordId) {
      state.discordId = null;
    }
    const currentViewer = await loadCurrentUser();
    let targetUser = null;
    if (state.discordId) {
      targetUser = await loadPublicUser(state.discordId).catch(() => null);
    } else if (geofsUserId) {
      targetUser = await loadPublicUserByGeofsId(geofsUserId).catch(() => null);
    } else {
      targetUser = currentViewer?.user || null;
    }

    if (!targetUser) {
      showError('No profile target available. Add ?discordId=<id>, ?geofsUserId=<id>, or sign in.');
      return;
    }
    state.discordId = targetUser.discordId || null;
    try {
      let stats = null;
      let flights = [];
      let medals = [];
      if (state.discordId) {
        [stats, flights, medals] = await Promise.all([
          loadStats(state.discordId),
          loadFlights(state.discordId, 200),
          loadMedals(state.discordId)
        ]);
        state.medals = Array.isArray(medals) ? medals : [];
      } else if (geofsUserId) {
        flights = await loadFlightsByGeofsId(geofsUserId, 200);
        stats = computeStatsFromFlights(flights);
        state.medals = [];
      }
      state.user = targetUser;
      state.stats = stats;
      state.flights = Array.isArray(flights) ? flights : [];
      state.heatmapSeries = buildHeatmapSeries(state.flights);
      state.minYear = Math.min(...state.flights.map(f => new Date(Number(f.startTime || 0)).getFullYear()).filter(Boolean), new Date().getFullYear());
      state.maxYear = Math.max(...state.flights.map(f => new Date(Number(f.startTime || 0)).getFullYear()).filter(Boolean), new Date().getFullYear());
      if (state.heatmapYear < state.minYear) state.heatmapYear = state.minYear;
      if (state.heatmapYear > state.maxYear) state.heatmapYear = state.maxYear;

      renderHeader(state.user, state.stats, state.flights);
      renderStats(state.stats, state.flights);
      renderFlights(state.flights);
      renderHeatmap(state.heatmapYear);
      setupHeatmapListeners();
      renderNavActions(currentViewer, state.discordId);
      applyProfileCustomizations(Boolean(currentViewer?.authenticated && currentViewer.user?.discordId === state.discordId));
      const isOwnProfile = Boolean(
        currentViewer?.authenticated &&
        currentViewer.user?.discordId === state.discordId
      );
      renderFeaturedMedal(state.medals);
      renderMedalInventory(state.medals, isOwnProfile);

      showContent();
      configureLeafletIcons();
      const airportDb = await loadAirportsDatabase();
      updateMap(state.flights, airportDb);
      // Leaflet needs the container to be visible before it can measure dimensions
      if (state.map) state.map.invalidateSize();

      if (getQueryParam('edit') === 'true' && currentViewer?.authenticated && currentViewer.user?.discordId === state.discordId) {
        openProfileSettingsModal();
      }

    } catch (error) {
      console.error(error);
      showError('Failed to load profile data.');
    }
  }

  function setupHeatmapListeners() {
    DOM.heatmapPrevYear.addEventListener('click', () => {
      if (state.heatmapYear > state.minYear) {
        state.heatmapYear -= 1;
        renderHeatmap(state.heatmapYear);
      }
    });

    DOM.heatmapNextYear.addEventListener('click', () => {
      if (state.heatmapYear < state.maxYear) {
        state.heatmapYear += 1;
        renderHeatmap(state.heatmapYear);
      }
    });

    DOM.heatmapCanvas.addEventListener('mousemove', handleHeatmapHover);
    DOM.heatmapCanvas.addEventListener('mouseleave', hideHeatmapTooltip);
  }

  return { init };
})();

window.addEventListener('load', () => {
  ProfileApp.init();
});
