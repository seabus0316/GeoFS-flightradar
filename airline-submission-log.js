const fs = require('fs');
const path = require('path');

const LOG_PATH = path.join(__dirname, 'data', 'airline-submissions.json');

function ensureLogFile() {
  const dir = path.dirname(LOG_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(LOG_PATH)) fs.writeFileSync(LOG_PATH, '[]\n', 'utf8');
}

function readLog() {
  ensureLogFile();
  try {
    const parsed = JSON.parse(fs.readFileSync(LOG_PATH, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.error('[AirlineSubmissionLog] Failed to read log:', err);
    return [];
  }
}

function writeLog(entries) {
  ensureLogFile();
  const tmpPath = `${LOG_PATH}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(entries, null, 2)}\n`, 'utf8');
  fs.renameSync(tmpPath, LOG_PATH);
}

function normalizeKey(value) {
  return String(value || '').trim().toUpperCase();
}

function getPayloadKey(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return '';
  const firstKey = Object.keys(payload)[0];
  const entry = payload[firstKey] || {};
  return normalizeKey(entry.icao || firstKey);
}

function appendAirlineSubmission({ payload, submitter = null }) {
  const entries = readLog();
  entries.push({
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    submittedAt: new Date().toISOString(),
    key: getPayloadKey(payload),
    payload,
    submitter,
    exportedAt: null,
  });
  writeLog(entries);
}

function buildAirlineExportBatch(limit = 50) {
  const entries = readLog();
  const exportedKeys = new Set(
    entries
      .filter(entry => entry.exportedAt)
      .map(entry => normalizeKey(entry.key || getPayloadKey(entry.payload)))
      .filter(Boolean)
  );
  const seenKeys = new Set();
  const selected = [];

  for (let i = entries.length - 1; i >= 0 && selected.length < limit; i -= 1) {
    const entry = entries[i];
    if (entry.exportedAt) continue;

    const key = normalizeKey(entry.key || getPayloadKey(entry.payload));
    if (!key || exportedKeys.has(key) || seenKeys.has(key)) continue;

    selected.unshift(entry);
    seenKeys.add(key);
  }

  const exportedAt = new Date().toISOString();
  const selectedIds = new Set(selected.map(entry => entry.id));
  let changed = false;

  for (const entry of entries) {
    if (selectedIds.has(entry.id)) {
      entry.exportedAt = exportedAt;
      changed = true;
    }
  }
  if (changed) writeLog(entries);

  const payload = {};
  for (const entry of selected) {
    Object.assign(payload, entry.payload);
  }

  return { payload, count: selected.length, exportedAt };
}

module.exports = {
  LOG_PATH,
  appendAirlineSubmission,
  buildAirlineExportBatch,
};
