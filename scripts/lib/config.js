const fs = require('fs');
const path = require('path');

const GITHUB_START_YEAR = 2008;
const SEARCH_DELAY_MS = 1000;

const COUNTRIES_FILE = path.join(__dirname, '..', '..', 'countries.json');
const DATA_DIR = path.join(__dirname, '..', '..', 'data');

const USER_COUNT_FILE = 'user_count.json';
const ORG_COUNT_FILE = 'org_count.json';

const COUNTRIES = JSON.parse(fs.readFileSync(COUNTRIES_FILE, 'utf-8'));

function resolveCountry(code) {
  const countryCode = (code || 'LK').toUpperCase();
  return { countryCode, config: COUNTRIES[countryCode] || null };
}

function validCountryCodes() {
  return Object.keys(COUNTRIES);
}

function totalYears(currentYear) {
  const years = [];
  for (let year = GITHUB_START_YEAR; year <= currentYear; year++) {
    years.push(year);
  }
  return years;
}

module.exports = {
  GITHUB_START_YEAR,
  SEARCH_DELAY_MS,
  DATA_DIR,
  USER_COUNT_FILE,
  ORG_COUNT_FILE,
  totalYears,
  resolveCountry,
  validCountryCodes
};
