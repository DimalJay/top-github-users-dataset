const { fetchSearchTotal } = require('./github-client');
const {
  ensureCountryDir,
  loadCounts,
  mergeRoot,
  saveCounts
} = require('./storage');
const {
  SEARCH_DELAY_MS,
  USER_COUNT_FILE,
  ORG_COUNT_FILE,
  totalYears
} = require('./config');

const sleep = ms => new Promise(r => setTimeout(r, ms));

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
      await sleep(SEARCH_DELAY_MS);
    }

    saveCounts(countryDir, dataset.fileName, counts);
    logger.log(`Saved ${Object.keys(counts).length} yearly counts to ${countryDir}/${dataset.fileName}`);

    // Merge only the freshly-computed years into the root aggregate.
    const fresh = {};
    for (const year of yearsToQuery(currentYear, hasExistingData)) {
      const key = String(year);
      if (counts[key] !== undefined) fresh[key] = counts[key];
    }
    mergeRoot(dataset.fileName, countryCode, fresh);
  }
}

module.exports = { refreshCountry };
