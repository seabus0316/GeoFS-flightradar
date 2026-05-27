const ProfileApp = (() => {
  const DOM = {
    loading: document.getElementById('profileLoading'),
    error: document.getElementById('profileError'),
    errorText: document.getElementById('profileErrorText'),
    content: document.getElementById('profileContent'),
    avatar: document.getElementById('profileAvatar'),
    status: document.getElementById('profileStatus'),
    statusTooltip: document.getElementById('profileStatusTooltip'),
    displayName: document.getElementById('profileDisplayName'),
    username: document.getElementById('profileUsername'),
    joined: document.getElementById('profileJoined'),
    achievements: document.getElementById('profileAchievements'),
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
    navActions: document.getElementById('profileNavActions')
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
    airportMarkers: []
  };

  const DEFAULT_AVATAR = 'https://i.ibb.co/Tg6mDts/default-avatar.png';
  const AIRPORTS_DB_URL = 'https://raw.githubusercontent.com/mwgg/Airports/refs/heads/master/airports.json';
  const STATUS_ONLINE_THRESHOLD_MS = 20 * 60 * 1000;

  function getQueryParam(name) {
    return new URLSearchParams(window.location.search).get(name);
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

  async function loadStats(discordId) {
    return apiGet(`/api/flights/stats/${encodeURIComponent(discordId)}`);
  }

  async function loadFlights(discordId, limit = 12) {
    return apiGet(`/api/flights/user/${encodeURIComponent(discordId)}?limit=${limit}`);
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

  function buildAchievements(stats) {
    const earned = [];
    const totalFlights = stats.totalFlights || 0;
    const totalDistance = stats.totalDistanceNm || 0;
    const totalDuration = stats.totalDuration || 0;
    const maxSpeed = stats.maxSpeed || 0;

    earned.push({ icon: '🛫', label: 'First Flight', active: totalFlights >= 1, hint: 'Logged first flight' });
    earned.push({ icon: '✈️', label: '10 Flights', active: totalFlights >= 10, hint: 'Completed 10 flights' });
    earned.push({ icon: '🌍', label: '1,000 nm', active: totalDistance >= 1000, hint: 'Accumulated 1,000 nautical miles' });
    earned.push({ icon: '⏱️', label: '25 Hours', active: totalDuration >= 25 * 3600, hint: 'Flown 25 hours' });

    const badges = earned.map(item => {
      const wrapper = document.createElement('div');
      wrapper.className = 'achievement-badge' + (item.active ? '' : ' empty');
      wrapper.innerHTML = `
        <span>${item.icon}</span>
        <div class="achievement-badge-tooltip">${item.label}<br><small>${item.hint}</small></div>
      `;
      return wrapper;
    });

    while (badges.length < 6) {
      const placeholder = document.createElement('div');
      placeholder.className = 'achievement-badge empty';
      placeholder.textContent = '—';
      badges.push(placeholder);
    }

    return badges;
  }

  function renderAchievements(stats) {
    DOM.achievements.innerHTML = '';
    const badges = buildAchievements(stats);
    badges.forEach(badge => DOM.achievements.appendChild(badge));
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
    const width = cols * (cell + gap) + margin * 2;
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
      const x = margin + col * (cell + gap);
      const y = margin + row * (cell + gap);

      ctx.fillStyle = color;
      ctx.fillRect(x, y, cell, cell);
      ctx.strokeStyle = 'rgba(0, 207, 255, 0.08)';
      ctx.strokeRect(x, y, cell, cell);
    });

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
    const col = Math.floor((x - margin) / (cell + gap));
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

  async function loadAirportsDatabase() {
    if (state.airports) return state.airports;
    try {
      const response = await fetch(AIRPORTS_DB_URL);
      if (!response.ok) throw new Error('Failed to load airport database');
      const raw = await response.json();
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
    } catch (error) {
      console.error('Unable to load airport database', error);
      state.airports = { icaoMap: new Map(), iataMap: new Map() };
      return state.airports;
    }
  }

  function resolveAirport(code, airportDb) {
    if (!code) return null;
    const normalized = String(code).trim().toUpperCase();
    if (!normalized) return null;
    if (airportDb.icaoMap.has(normalized)) return airportDb.icaoMap.get(normalized);
    if (airportDb.iataMap.has(normalized)) return airportDb.iataMap.get(normalized);
    return null;
  }

  function updateMap(flights, airportDb) {
    if (!state.map) {
      state.map = L.map(DOM.mapContainer, {
        worldCopyJump: true,
        zoomControl: false
      }).setView([20, 0], 2);
      state.tileLayer = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; OpenStreetMap contributors'
      }).addTo(state.map);
    }

    state.airportMarkers.forEach(marker => state.map.removeLayer(marker));
    state.airportMarkers = [];

    const visited = new Map();
    flights.forEach(flight => {
      if (flight.departure) visited.set(flight.departure.toUpperCase(), flight.departure.toUpperCase());
      if (flight.arrival) visited.set(flight.arrival.toUpperCase(), flight.arrival.toUpperCase());
    });

    const airportMeta = [];
    visited.forEach(code => {
      const apt = resolveAirport(code, airportDb);
      if (apt && Number.isFinite(apt.lat) && Number.isFinite(apt.lon)) {
        airportMeta.push(apt);
      }
    });

    if (airportMeta.length) {
      airportMeta.forEach(apt => {
        const marker = L.marker([apt.lat, apt.lon], {
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
    if (viewer?.authenticated && viewer.user?.discordId === targetDiscordId) {
      const editLink = document.createElement('a');
      editLink.href = '/profile.html?edit=true';
      editLink.className = 'profile-nav-action';
      editLink.textContent = 'Edit profile';
      DOM.navActions.appendChild(editLink);
    }
  }

  async function init() {
    state.discordId = getQueryParam('discordId');
    if (!state.discordId) {
      state.discordId = null;
    }

    const publicUser = state.discordId ? await loadPublicUser(state.discordId).catch(() => null) : null;
    const currentViewer = await loadCurrentUser();
    const user = publicUser || currentViewer?.user || null;

    if (!user) {
      showError('No profile target available. Add ?discordId=<id> or sign in.');
      return;
    }

    state.discordId = user.discordId;
    try {
      const [stats, flights] = await Promise.all([
        loadStats(state.discordId),
        loadFlights(state.discordId, 12)
      ]);
      state.user = user;
      state.stats = stats;
      state.flights = Array.isArray(flights) ? flights : [];
      state.heatmapSeries = buildHeatmapSeries(state.flights);
      state.minYear = Math.min(...state.flights.map(f => new Date(Number(f.startTime || 0)).getFullYear()).filter(Boolean), new Date().getFullYear());
      state.maxYear = Math.max(...state.flights.map(f => new Date(Number(f.startTime || 0)).getFullYear()).filter(Boolean), new Date().getFullYear());
      if (state.heatmapYear < state.minYear) state.heatmapYear = state.minYear;
      if (state.heatmapYear > state.maxYear) state.heatmapYear = state.maxYear;

      renderHeader(state.user, state.stats, state.flights);
      renderAchievements(state.stats);
      renderStats(state.stats, state.flights);
      renderFlights(state.flights);
      renderHeatmap(state.heatmapYear);
      setupHeatmapListeners();
      renderNavActions(currentViewer, state.discordId);

      const airportDb = await loadAirportsDatabase();
      updateMap(state.flights, airportDb);
      showContent();
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
