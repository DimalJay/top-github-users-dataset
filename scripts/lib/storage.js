const fs = require('fs');
const path = require('path');

const { DATA_DIR } = require('./config');

function writeJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

function readJsonIfExists(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch (e) {
    return null;
  }
}

// Per-country files are wrapped as { last_updated, total, counts }. Returns just
// the year -> count map, or an empty object if the file is missing/corrupt.
function loadCounts(countryDir, fileName) {
  const parsed = readJsonIfExists(path.join(countryDir, fileName));
  if (!parsed) return {};
  return (parsed && parsed.counts) ? parsed.counts : parsed;
}

function saveCounts(countryDir, fileName, counts) {
  const output = {
    last_updated: new Date().toISOString(),
    total: Object.values(counts).reduce((sum, n) => sum + (n || 0), 0),
    counts
  };
  writeJson(path.join(countryDir, fileName), output);
}

function ensureCountryDir(countryCode) {
  const dir = path.join(DATA_DIR, countryCode);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

module.exports = { loadCounts, saveCounts, ensureCountryDir };
