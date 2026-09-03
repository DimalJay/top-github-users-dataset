const fs = require('fs');
const path = require('path');

const SEARCH_PER_PAGE = 100;
const GRAPHQL_API = 'https://api.github.com/graphql';

const COUNTRIES = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'countries.json'), 'utf-8')
);

const COUNTRY_CODE = (process.argv[2] || 'LK').toUpperCase();

if (!COUNTRIES[COUNTRY_CODE]) {
  console.error(`Error: Unknown country code '${COUNTRY_CODE}'. Valid codes: ${Object.keys(COUNTRIES).join(', ')}`);
  process.exit(1);
}

const LOCATION = COUNTRIES[COUNTRY_CODE].location;
const MAX_USERS = COUNTRIES[COUNTRY_CODE].maxUsers;

// GraphQL node budget preservation: 20 users per request keeps the point/request
// overhead low while staying under GitHub's per-query resource limits.
const GRAPHQL_BATCH = 20;
const GRAPHQL_MIN_BATCH = 1;

// Multi-pass discovery strategy. Multiple orthogonal search sweeps capture follower
// leaders, prolific repository creators, newly-joined accounts, and star-earning
// developers respectively, maximizing the distinct candidate pool before filtering.
const DISCOVERY_PASSES = [
  { name: 'followers', sort: 'followers', order: 'desc' },
  { name: 'repositories', sort: 'repositories', order: 'desc' },
  { name: 'joined', sort: 'joined', order: 'desc' },
  { name: 'stars', sort: 'stars', order: 'desc' }
];
// GitHub caps each Search query at 1000 results (10 pages * per_page=100). Sweeping
// the full depth per pass maximizes distinct candidates eligible for the >1000
// contributions + >20 followers filters before ranking to MAX_USERS.
const PASS_MAX_PAGES = 10;

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// Wait until the current rate-limit window resets. Prefers the authoritative
// `x-ratelimit-reset` header (UTC epoch in seconds); falls back to a fixed delay.
async function waitForRateLimitReset(response) {
  const headerReset = response.headers.get('x-ratelimit-reset');
  const retryAfter = response.headers.get('Retry-After');

  if (headerReset) {
    const resetMs = parseInt(headerReset, 10) * 1000;
    const waitMs = Math.max(1000, resetMs - Date.now());
    console.log(`    Rate limited. Waiting ${Math.round(waitMs / 1000)}s until reset...`);
    await sleep(waitMs);
    return;
  }

  const waitSec = retryAfter ? parseInt(retryAfter, 10) : 60;
  console.log(`    Rate limited. Waiting ${waitSec}s...`);
  await sleep(waitSec * 1000);
}

async function fetchSearchQuery(queryString, token) {
  const url = `https://api.github.com/search/users?q=${queryString}`;

  for (let attempt = 1; attempt <= 5; attempt++) {
    const response = await fetch(url, {
      headers: {
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'Node-Fetch-Script',
        'Authorization': `Bearer ${token}`
      }
    });

    if (response.status === 403 || response.status === 429) {
      await waitForRateLimitReset(response);
      continue;
    }

    // 5xx (e.g. 502 Bad Gateway) is transient — retry with backoff instead of aborting.
    if (response.status >= 500 && response.status < 600) {
      const backoff = Math.min(30, 5 * attempt) * 1000;
      console.log(`    Transient server error ${response.status}. Retrying in ${backoff / 1000}s (attempt ${attempt}/5)...`);
      await sleep(backoff);
      continue;
    }

    if (!response.ok) {
      throw new Error(`Search API error: ${response.status} ${response.statusText}`);
    }

    return await response.json();
  }
  throw new Error('Search API rate limit exceeded after retries.');
}

// Step 1: Historical seed ingestion (zero API cost). Load prior ranked user
// records keyed by lowercase login so the full identity fields are preserved.
function loadSeedCandidates(targetDir) {
  const seedFile = path.join(targetDir, 'top_users_contributors.json');
  const seedMap = new Map(); // lowercase login -> record

  if (fs.existsSync(seedFile)) {
    try {
      const data = JSON.parse(fs.readFileSync(seedFile, 'utf-8'));
      if (data && Array.isArray(data.users)) {
        for (const u of data.users) {
          if (u && u.username) {
            seedMap.set(u.username.toLowerCase(), u);
          }
        }
      }
      console.log(`Loaded ${seedMap.size} seed candidates from previous data.`);
    } catch (e) {
      console.log('  Could not parse previous data; starting with empty seed.');
    }
  }

  return seedMap;
}

// Build the query string (everything after `?q=`) for a single search pass + page.
function buildPassQueryString(sort, page) {
  const loc = LOCATION ? `location:"${encodeURIComponent(LOCATION)}"+` : '';
  return `${loc}type:user+followers:%3E20&sort=${sort}&order=desc&per_page=${SEARCH_PER_PAGE}&page=${page}`;
}

// Merge a search response's items into the candidate map, deduping case-insensitively.
function mergeSearchItems(candidateMap, items) {
  let added = 0;
  for (const item of items) {
    const key = item.login.toLowerCase();
    if (!candidateMap.has(key) && item.login) {
      candidateMap.set(key, { ...item, username: item.login });
      added++;
    }
  }
  return added;
}

// Step 2: Multi-pass candidate harvesting. Sweep each discovery pass (followers,
// repositories, joined) for up to PASS_MAX_PAGES pages, deduping into one pool.
// `sleep(1000)` between requests keeps us comfortably under the 30 req/min Search cap.
async function collectCandidates(seedMap, token) {
  const candidateMap = new Map(); // lowercase login -> record/login item

  for (const [login, record] of seedMap) {
    // Normalize: output records store `username`; search items store `login`.
    candidateMap.set(login, { ...record, login: record.login ?? record.username, username: record.login ?? record.username });
  }

  let totalAdded = 0;
  for (const pass of DISCOVERY_PASSES) {
    let passNew = 0;
    for (let page = 1; page <= PASS_MAX_PAGES; page++) {
      const q = buildPassQueryString(pass.sort, page);
      const data = await fetchSearchQuery(q, token);
      const items = data.items || [];
      const added = mergeSearchItems(candidateMap, items);
      passNew += added;
      console.log(`  Pass "${pass.name}" page ${page}: ${items.length} users (${added} new).`);
      if (items.length < SEARCH_PER_PAGE) break; // last page
      await sleep(1000);
    }
    totalAdded += passNew;
  }

  const allItems = [...candidateMap.values()];
  console.log(`Candidate pool: ${allItems.length} unique users (${seedMap.size} seed + ${totalAdded} new).`);
  return { items: allItems, usernames: allItems.map(c => c.login) };
}

async function collectCandidatesOrBootstrap(targetDir, token) {
  const seedMap = loadSeedCandidates(targetDir);

  // Cold run: no seed file exists. The multi-pass sweeps bootstraps the pool.
  if (seedMap.size === 0) {
    console.log('Cold run: no previous data found. Bootstrapping initial pool via multi-pass search...');
  }

  return collectCandidates(seedMap, token);
}

function buildContributionsQuery(usernames) {
  const field = (name, login) => `
    ${name}: user(login: "${login}") {
      name
      login
      bio
      company
      location
      followersCount: followers { totalCount }
      contributionsCollection {
        totalCommitContributions
        totalPullRequestContributions
        totalIssueContributions
        totalPullRequestReviewContributions
        contributionCalendar { totalContributions }
      }
    }
  `;
  const selections = usernames.map((u, i) => field(`u${i}`, uLoginSafe(u))).join('\n');
  return `query { ${selections} }`;
}

function uLoginSafe(login) {
  // GraphQL string literals cannot contain stray quotes/backslashes.
  return String(login).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

// Execute a single GraphQL request for a batch. Returns username-keyed data or
// an object describing a resource-limit failure that the caller can react to.
async function fetchContributionsBatchOnce(usernames, token) {
  const query = buildContributionsQuery(usernames);

  let lastServerError = false;
  for (let attempt = 1; attempt <= 5; attempt++) {
    const response = await fetch(GRAPHQL_API, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'User-Agent': 'Node-Fetch-Script'
      },
      body: JSON.stringify({ query })
    });

    if (response.status === 401 || response.status === 403 || response.status === 429) {
      await waitForRateLimitReset(response);
      return { rateLimited: true };
    }

    // 5xx (e.g. 502/504) is transient — heavy batches can time out. Retry a
    // couple of times, then split the batch (handled by the caller).
    if (response.status >= 500 && response.status < 600) {
      lastServerError = true;
      const backoff = Math.min(15, 4 * attempt) * 1000;
      console.log(`    Transient server error ${response.status}. Retrying in ${backoff / 1000}s (attempt ${attempt}/5)...`);
      await sleep(backoff);
      continue;
    }

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`GraphQL API error: ${response.status} ${err}`);
    }

    const data = await response.json();

    if (data.errors && data.errors.length) {
      const resourceLimit = data.errors.filter(e => e.type === 'RESOURCE_LIMITS_EXCEEDED');
      const other = data.errors.filter(e => e.type !== 'RESOURCE_LIMITS_EXCEEDED' && e.type !== 'NOT_FOUND');

      if (resourceLimit.length) {
        return { resourceLimit: true };
      }
      if (other.length) {
        throw new Error(`GraphQL errors: ${JSON.stringify(other.slice(0, 5))}`);
      }
      // NOT_FOUND entries are fine — the caller fills them with zeros.
    }

    const result = {};
    for (let i = 0; i < usernames.length; i++) {
      result[usernames[i].toLowerCase()] = data.data[`u${i}`] || null;
    }
    return { data: result };
  }
  if (lastServerError) {
    return { serverError: true };
  }
  throw new Error('GraphQL rate limit exceeded after retries.');
}

// Fetch contributions for a batch, transparently splitting into smaller
// sub-batches when a request exceeds resource limits or keeps timing out.
async function fetchContributionsBatch(usernames, token) {
  const outcome = await fetchContributionsBatchOnce(usernames, token);

  if (outcome.data) {
    return outcome.data;
  }

  // Rate limited: the request never ran, so no point re-splitting.
  if (outcome.rateLimited) {
    throw new Error('GraphQL rate limit exceeded.');
  }

  // Resource limits exceeded OR persistent server errors — split in half and merge.
  if (usernames.length <= GRAPHQL_MIN_BATCH) {
    // A single user can still exceed the budget (extreme contribution calendars).
    // Fall back to a leaner query (drop the per-type totals, keep total only).
    const leanOutcome = await fetchContributionsBatchLean(usernames, token);
    return leanOutcome.data || Object.fromEntries(usernames.map(u => [u.toLowerCase(), null]));
  }

  const mid = Math.ceil(usernames.length / 2);
  const left = await fetchContributionsBatch(usernames.slice(0, mid), token);
  const right = await fetchContributionsBatch(usernames.slice(mid), token);
  return { ...left, ...right };
}

// Minimal fallback used for extreme single-user resource-limit cases: request
// only the contribution calendar total (cheapest possible query).
async function fetchContributionsBatchLean(usernames, token) {
  const query = `query { ${usernames.map((u, i) => `
    u${i}: user(login: "${uLoginSafe(u)}") {
      name
      login
      bio
      company
      location
      followersCount: followers { totalCount }
      contributionsCollection { contributionCalendar { totalContributions } }
    }`).join('\n')} }`;

  for (let attempt = 1; attempt <= 5; attempt++) {
    const response = await fetch(GRAPHQL_API, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'User-Agent': 'Node-Fetch-Script'
      },
      body: JSON.stringify({ query })
    });

    if (response.status === 401 || response.status === 403 || response.status === 429) {
      await waitForRateLimitReset(response);
      continue;
    }
    if (response.status >= 500 && response.status < 600) {
      const backoff = Math.min(15, 4 * attempt) * 1000;
      console.log(`    Transient server error ${response.status} (lean). Retrying in ${backoff / 1000}s...`);
      await sleep(backoff);
      continue;
    }
    if (!response.ok) {
      const err = await response.text();
      throw new Error(`GraphQL API error (lean): ${response.status} ${err}`);
    }

    const data = await response.json();
    const result = {};
    for (let i = 0; i < usernames.length; i++) {
      result[usernames[i].toLowerCase()] = (data.data && data.data[`u${i}`]) || null;
    }
    return { data: result };
  }
  throw new Error('GraphQL rate limit exceeded (lean).');
}

async function fetchContributions(usernames, token, progressFile) {
  const contribData = {};

  if (fs.existsSync(progressFile)) {
    try {
      const existing = JSON.parse(fs.readFileSync(progressFile, 'utf-8'));
      if (existing && Array.isArray(existing)) {
        for (const entry of existing) {
          contribData[entry.username.toLowerCase()] = {
            name: entry.name ?? null,
            followers_count: entry.followers_count ?? null,
            total_contributions: entry.total_contributions ?? 0,
            bio: entry.bio ?? null,
            company: entry.company ?? null,
            location: entry.location ?? null
          };
        }
        console.log(`  Resuming from existing progress (${Object.keys(contribData).length} users already fetched).`);
      }
    } catch (e) {
      console.log('  Could not load progress file, starting fresh.');
    }
  }

  const todo = usernames.filter(u => !contribData[u.toLowerCase()]);
  console.log(`  Fetching contribution counts for ${todo.length} users via GraphQL (batched)...`);

  for (let i = 0; i < todo.length; i += GRAPHQL_BATCH) {
    const batch = todo.slice(i, i + GRAPHQL_BATCH);
    const result = await fetchContributionsBatch(batch, token);

    for (let j = 0; j < batch.length; j++) {
      const username = batch[j].toLowerCase();
      const node = result[username];

      if (!node || !node.login) {
        // User not found or renamed — record with zero contributions.
        contribData[username] = {
          name: null,
          followers_count: null,
          total_contributions: 0,
          bio: null,
          company: null,
          location: null
        };
        continue;
      }

      const cal = (node.contributionsCollection && node.contributionsCollection.contributionCalendar) || {};
      contribData[username] = {
        name: node.name ?? null,
        followers_count: (node.followersCount && node.followersCount.totalCount) ?? null,
        total_contributions: cal.totalContributions ?? 0,
        bio: node.bio ?? null,
        company: node.company ?? null,
        location: node.location ?? null
      };
    }

    fs.writeFileSync(progressFile, JSON.stringify(
      Object.entries(contribData).map(([u, e]) => ({
        username: u,
        name: e.name,
        followers_count: e.followers_count,
        total_contributions: e.total_contributions,
        bio: e.bio,
        company: e.company,
        location: e.location
      })),
      null, 2
    ));

    const done = todoCountDone(contribData, usernames);
    if (done % 100 === 0) {
      console.log(`  Fetched contributions for ${done}/${usernames.length} users...`);
    }

    await sleep(500);
  }

  return contribData;
}

function todoCountDone(contribData, usernames) {
  let count = 0;
  for (const u of usernames) {
    if (contribData[u.toLowerCase()]) count++;
  }
  return count;
}

async function updateTopContributors() {
  const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

  if (!GITHUB_TOKEN) {
    console.error('Error: GITHUB_TOKEN environment variable is required for the GitHub API.');
    console.error('Set it with: export GITHUB_TOKEN=your_token');
    process.exit(1);
  }

  const targetDir = path.join(__dirname, '..', 'data', COUNTRY_CODE);
  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }

  const { items, usernames } = await collectCandidatesOrBootstrap(targetDir, GITHUB_TOKEN);

  const progressFile = path.join(targetDir, '_progress_contributors.json');
  const contribData = await fetchContributions(usernames, GITHUB_TOKEN, progressFile);

  // Rank the candidate pool by real contribution counts, descending.
  const ranked = items
    .map((user) => {
      const data = contribData[user.login.toLowerCase()] || {};
      return {
        rank: 0,
        name: data.name ?? null,
        username: user.login,
        avatar_url: user.avatar_url ?? null,
        profile_url: user.profile_url ?? user.html_url ?? null,
        id: user.id ?? null,
        total_contributions: data.total_contributions ?? 0,
        followers_count: data.followers_count ?? null,
        bio: data.bio ?? null,
        company: data.company ?? null,
        location: data.location ?? null
      };
    })
    // Requirement: keep only users with >20 followers AND >1000 total contributions.
    .filter((u) => (u.followers_count ?? 0) > 20 && u.total_contributions > 1000)
    .sort((a, b) => b.total_contributions - a.total_contributions)
    .slice(0, MAX_USERS)
    .map((user, index) => ({ ...user, rank: index + 1 }));

  const outputData = {
    last_updated: new Date().toISOString(),
    total_count: ranked.length,
    users: ranked
  };

  const targetFilePath = path.join(targetDir, 'top_users_contributors.json');

  fs.writeFileSync(targetFilePath, JSON.stringify(outputData, null, 2));
  // The rotating-cursor state file is no longer written by this design.
  if (fs.existsSync(path.join(targetDir, '_cursor_state.json'))) {
    fs.unlinkSync(path.join(targetDir, '_cursor_state.json'));
  }
  if (fs.existsSync(progressFile)) {
    fs.unlinkSync(progressFile);
  }
  console.log(`Saved ${ranked.length} top contributors to ${targetFilePath}`);
}

updateTopContributors().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
