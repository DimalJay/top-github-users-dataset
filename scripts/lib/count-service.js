const { fetchSearchTotal } = require('./github-client');
const {
  ensureCountryDir,
  loadCounts,
  saveCounts
} = require('./storage');
const {
  USER_COUNT_FILE,
  ORG_COUNT_FILE,
  totalYears
} = require('./config');

// Dataset definitions: file name, account type, and the human label for logs.
const DATASETS = [
  { fileName: USER_COUNT_FILE, type: 'user', label: 'users' },
  { fileName: ORG_COUNT_FILE, type: 'org', label: 'orgs' }
];

// If a country already has stored data we only refresh the current year; a fresh
// country gets a full sweep from GitHub's founding year through the current year.
function yearsToQuery(currentYear, hasExistingData) {
  if (hasExistingData) return [currentYear];
  return totalYears(currentYear);
}

async function refreshCountry({ countryCode, location, token, logger = console }) {
  const countryDir = ensureCountryDir(countryCode);
  const currentYear = new Date().getFullYear();

  logger.log(`Computing account counts for ${countryCode} (${location || 'Worldwide'}) by year...`);

  for (const dataset of DATASETS) {
    const existing = loadCounts(countryDir, dataset.fileName);
    const hasExistingData = Object.keys(existing).length > 0;
    const counts = { ...existing };

    for (const year of yearsToQuery(currentYear, hasExistingData)) {
      const key = String(year);
      const isCurrentYear = year === currentYear;
      // Preserve older years; always re-fetch the current year.
      if (counts[key] !== undefined && !isCurrentYear) continue;

      const count = await fetchSearchTotal({
        location,
        type: dataset.type,
        year,
        token
      });
      counts[key] = count;
      logger.log(`  ${year}: ${count} ${dataset.label}`);
    }

    saveCounts(countryDir, dataset.fileName, counts);
    logger.log(`Saved ${Object.keys(counts).length} yearly counts to ${countryDir}/${dataset.fileName}`);
  }
}

module.exports = { refreshCountry };
