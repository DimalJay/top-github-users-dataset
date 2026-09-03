const SEARCH_API = 'https://api.github.com/search/users';
const RATE_LIMIT_API = 'https://api.github.com/rate_limit';
const SEARCH_PER_PAGE = 1;
const MAX_ATTEMPTS = 5;

const USER_AGENT = 'Node-Fetch-Script';

// Floor between consecutive requests. GitHub's Search primary quota can be as low
// as 10 req/min for fine-grained tokens, so we also pace by the remaining count.
const MIN_REQUEST_INTERVAL_MS = 1000;

// Shared throttle state tracked across requests so we never exhaust the quota.
let remaining = null; // x-ratelimit-remaining from the last response
let resetAt = 0; // x-ratelimit-reset epoch seconds from the last response
let lastRequestAt = 0;

function buildQuery(location, type, year) {
  const loc = location ? `location:"${encodeURIComponent(location)}"+` : '';
  const from = `${year}-01-01`;
  const to = `${year}-12-31`;
  return `${loc}type:${type}+created:${from}..${to}`;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// Paces request start based on shared rate-limit state so we wait BEFORE the
// limit is exhausted rather than reacting to 403s.
async function throttle() {
  const sinceLast = Date.now() - lastRequestAt;
  if (sinceLast < MIN_REQUEST_INTERVAL_MS) {
    await sleep(MIN_REQUEST_INTERVAL_MS - sinceLast);
  }

  if (remaining !== null && remaining <= 0 && resetAt * 1000 > Date.now()) {
    const waitMs = resetAt * 1000 - Date.now();
    console.log(`    Quota exhausted (${remaining} left). Waiting ${Math.ceil(waitMs / 1000)}s until reset...`);
    await sleep(waitMs + 1000);
  }
}

function trackRateLimit(response) {
  const head = response.headers.get('x-ratelimit-remaining');
  if (head !== null) remaining = parseInt(head, 10) || 0;
  const reset = response.headers.get('x-ratelimit-reset');
  if (reset) resetAt = parseInt(reset, 10) || 0;
}

// Waits out an active rate-limit response. Prefers `Retry-After`, then the live
// /rate_limit endpoint for the authoritative Search reset time.
async function waitForRateLimitReset(response, token) {
  const retryAfter = response.headers.get('Retry-After');
  if (retryAfter) {
    const waitSec = parseInt(retryAfter, 10);
    console.log(`    Rate limited. Waiting ${waitSec}s...`);
    await sleep(waitSec * 1000);
    return;
  }

  try {
    const response = await fetch(RATE_LIMIT_API, {
      headers: {
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': USER_AGENT,
        'Authorization': `Bearer ${token}`
      }
    });
    if (response.ok) {
      const data = await response.json();
      const search = (data.resources && data.resources.search) || {};
      remaining = search.remaining ?? null;
      if (search.reset) resetAt = parseInt(search.reset, 10) || 0;
      const waitMs = Math.max(1000, resetAt * 1000 - Date.now());
      console.log(`    Search quota exhausted. Waiting ${Math.round(waitMs / 1000)}s until reset...`);
      await sleep(waitMs + 5000);
    }
  } catch (e) {
    // fall through to fixed delay
  }
  await sleep(60000);
}

// Returns the total match count for a search query, or null if the query fails.
// GitHub stops counting reliably past 1000 (total_count is approximate above that).
// Retrieves it with retries for rate limits and transient 5xx errors.
async function fetchSearchTotal({ location, type, year, token }) {
  const query = buildQuery(location, type, year);
  const url = `${SEARCH_API}?q=${query}&per_page=${SEARCH_PER_PAGE}`;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    await throttle();

    const response = await fetch(url, {
      headers: {
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': USER_AGENT,
        'Authorization': `Bearer ${token}`
      }
    });
    lastRequestAt = Date.now();
    trackRateLimit(response);

    if (response.status === 403 || response.status === 429) {
      await waitForRateLimitReset(response, token);
      continue;
    }

    if (response.status >= 500 && response.status < 600) {
      const backoffMs = Math.min(30, 5 * attempt) * 1000;
      console.log(`    Transient server error ${response.status}. Retrying in ${backoffMs / 1000}s (attempt ${attempt}/${MAX_ATTEMPTS})...`);
      await sleep(backoffMs);
      continue;
    }

    if (!response.ok) {
      console.error(`  Search API error: ${response.status} ${response.statusText}`);
      return null;
    }

    const data = await response.json();
    return data.total_count ?? 0;
  }

  throw new Error('Search API rate limit exceeded after retries.');
}

// Exposed for tests: reset the shared throttle state between runs.
function resetThrottle() {
  remaining = null;
  resetAt = 0;
  lastRequestAt = 0;
}

module.exports = { fetchSearchTotal, resetThrottle };
