const fs = require('fs');
const path = require('path');

const SEARCH_PER_PAGE = 100;
const SEARCH_MAX_PAGES = 10; // GitHub caps search results at 1000 (10 pages of 100)
const SEARCH_MAX_RESULTS = SEARCH_PER_PAGE * SEARCH_MAX_PAGES;
const REST_DELAY_MS = 250;
const REST_API = 'https://api.github.com/users';
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
// How many candidates to gather before ranking by contributions. A larger pool
// produces a truer "top contributors" ranking but costs more GraphQL points.
const POOL_MULTIPLIER = COUNTRIES[COUNTRY_CODE].poolMultiplier || 3;
const POOL_SIZE = Math.max(MAX_USERS, MAX_USERS * POOL_MULTIPLIER);

// GraphQL node budget preservation: keep batch size modest so a single request
// never blows through the latency/parse budget or rate limit.
const GRAPHQL_BATCH = 20;

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function coreResetWait(token) {
  try {
    const response = await fetch('https://api.github.com/rate_limit', {
      headers: {
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'Node-Fetch-Script',
        'Authorization': `Bearer ${token}`
      }
    });
    if (response.ok) {
      const data = await response.json();
      const resetAt = (data.resources && data.resources.core && data.resources.core.reset) || 0;
      const waitMs = Math.max(1000, (resetAt * 1000) - Date.now());
      return waitMs;
    }
  } catch (e) {
    // fall through
  }
  return 60000;
}

async function fetchSearchPage(page, token) {
  const locationFilter = LOCATION ? `location:"${encodeURIComponent(LOCATION)}"+` : '';
  // No sort=followers: we want a broad pool that is then ranked by real
  // contribution counts (default search ordering, which is account/joined order).
  const url = `https://api.github.com/search/users?q=${locationFilter}type:user&per_page=${SEARCH_PER_PAGE}&page=${page}`;

  for (let attempt = 1; attempt <= 5; attempt++) {
    const response = await fetch(url, {
      headers: {
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'Node-Fetch-Script',
        'Authorization': `Bearer ${token}`
      }
    });

    if (response.status === 403 || response.status === 429) {
      const retryAfter = response.headers.get('Retry-After') || 60;
      console.log(`    Rate limited. Waiting ${retryAfter}s (attempt ${attempt}/5)...`);
      await sleep(retryAfter * 1000);
      continue;
    }

    // 422 means we've gone past the 1000-result search ceiling. Signal "no more".
    if (response.status === 422) {
      return null;
    }

    if (!response.ok) {
      throw new Error(`Search API error: ${response.status} ${response.statusText}`);
    }

    return await response.json();
  }
  throw new Error('Search API rate limit exceeded after retries.');
}

async function fetchAllSearchResults(token) {
  const allItems = [];
  let page = 1;

  console.log(`Gathering candidate pool (up to ${POOL_SIZE}) for ${COUNTRY_CODE} (${LOCATION || 'Worldwide'})...`);

  while (allItems.length < POOL_SIZE) {
    console.log(`  Fetching search page ${page}...`);
    const data = await fetchSearchPage(page, token);
    if (!data) {
      console.log(`  Reached search result ceiling (max ${SEARCH_MAX_RESULTS}); stopping.`);
      break;
    }
    const items = data.items || [];

    if (items.length === 0) break;
    allItems.push(...items);

    if (allItems.length >= data.total_count) break;
    page++;

    if (page > Math.ceil(Math.min(POOL_SIZE, SEARCH_MAX_RESULTS) / SEARCH_PER_PAGE)) break;
  }

  if (allItems.length > POOL_SIZE) {
    allItems.length = POOL_SIZE;
  }

  return allItems;
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

async function fetchContributionsBatch(usernames, token) {
  const query = buildContributionsQuery(usernames);

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
      const retryAfter = response.headers.get('Retry-After');
      if (retryAfter) {
        console.log(`    Rate limited. Waiting ${retryAfter}s (attempt ${attempt}/5)...`);
        await sleep(retryAfter * 1000);
        continue;
      }
      console.log(`    GraphQL quota/build limit hit. Waiting 60s (attempt ${attempt}/5)...`);
      await sleep(60000);
      continue;
    }

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`GraphQL API error: ${response.status} ${err}`);
    }

    const data = await response.json();

    if (data.errors && data.errors.length) {
      const nonNull = (data.errors || []).filter(e => e.type !== 'NOT_FOUND');
      if (nonNull.length) {
        throw new Error(`GraphQL errors: ${JSON.stringify(nonNull.slice(0, 5))}`);
      }
      // NOT_FOUND for a single user is fine — skip that user's data below.
    }

    return data.data || {};
  }
  throw new Error('GraphQL rate limit exceeded after retries.');
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
      const alias = `u${j}`;
      const node = result[alias];
      const username = batch[j].toLowerCase();

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

  const items = await fetchAllSearchResults(GITHUB_TOKEN);
  console.log(`Candidate pool: ${items.length} users.`);

  const targetDir = path.join(__dirname, '..', 'data', COUNTRY_CODE);
  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }

  const progressFile = path.join(targetDir, '_progress_contributors.json');
  const usernames = items.map(u => u.login);
  const contribData = await fetchContributions(usernames, GITHUB_TOKEN, progressFile);

  // Rank the candidate pool by real contribution counts, descending.
  const ranked = items
    .map((user, index) => {
      const data = contribData[user.login.toLowerCase()] || {};
      return {
        rank: 0,
        name: data.name ?? null,
        username: user.login,
        avatar_url: user.avatar_url,
        profile_url: user.html_url,
        id: user.id,
        total_contributions: data.total_contributions ?? 0,
        followers_count: data.followers_count ?? null,
        bio: data.bio ?? null,
        company: data.company ?? null,
        location: data.location ?? null
      };
    })
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
  if (fs.existsSync(progressFile)) {
    fs.unlinkSync(progressFile);
  }
  console.log(`Saved ${ranked.length} top contributors to ${targetFilePath}`);
}

updateTopContributors().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
