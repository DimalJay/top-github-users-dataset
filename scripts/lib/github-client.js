const SEARCH_API = 'https://api.github.com/search/users';
const RATE_LIMIT_API = 'https://api.github.com/rate_limit';
const SEARCH_PER_PAGE = 1;
const MAX_ATTEMPTS = 5;

const USER_AGENT = 'Node-Fetch-Script';

function buildQuery(location, type, year) {
  const loc = location ? `location:"${encodeURIComponent(location)}"+` : '';
  const from = `${year}-01-01`;
  const to = `${year}-12-31`;
  return `${loc}type:${type}+created:${from}..${to}`;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// Waits until the current rate-limit window resets. Prefers the authoritative
// `x-ratelimit-reset` header (UTC epoch in seconds), then `Retry-After`, then a
// live /rate_limit lookup, before falling back to a fixed delay.
async function waitForRateLimitReset(response, token) {
  const headerReset = response.headers.get('x-ratelimit-reset');
  const retryAfter = response.headers.get('Retry-After');

  if (headerReset) {
    const waitMs = Math.max(1000, parseInt(headerReset, 10) * 1000 - Date.now());
    console.log(`    Rate limited. Waiting ${Math.round(waitMs / 1000)}s until reset...`);
    await sleep(waitMs);
    return;
  }

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
      const resetAt =
        (data.resources && data.resources.search && data.resources.search.reset) || 0;
      const waitMs = Math.max(1000, resetAt * 1000 - Date.now());
      console.log(`    Search quota exhausted. Waiting ${Math.round(waitMs / 1000)}s until reset...`);
      await sleep(waitMs + 5000);
      return;
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
    const response = await fetch(url, {
      headers: {
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': USER_AGENT,
        'Authorization': `Bearer ${token}`
      }
    });

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

module.exports = { fetchSearchTotal };
