const fs = require('fs');
const path = require('path');

const SEARCH_PER_PAGE = 100;
const SEARCH_MAX_PAGES = 10; // GitHub caps a single query at 1000 results (10 pages of 100)
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
const POOL_MULTIPLIER = COUNTRIES[COUNTRY_CODE].poolMultiplier || 3;
const POOL_SIZE = Math.max(MAX_USERS, MAX_USERS * POOL_MULTIPLIER);

// GraphQL node budget preservation: keep batch size modest so a single request
// never blows through the latency/parse budget or rate limit.
const GRAPHQL_BATCH = 20;

// Immutable, non-overlapping creation-date partitions. Splitting into three
// ranges lets us exceed the 1,000-result search ceiling without 422 errors,
// since each partition is its own cap of 1,000.
const DATE_PARTITIONS = [
  'created:>=2023-01-01',
  'created:2020-01-01..2022-12-31',
  'created:<2020-01-01'
];

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

async function fetchSearchPage(partition, page, token) {
  const locationFilter = LOCATION ? `location:"${encodeURIComponent(LOCATION)}"+` : '';
  // sort=repositories within a partition surfaces active, high-volume developers
  // (far better than GitHub's fuzzy default "Best Match", which returns inactive
  // accounts that merely match the location string).
  const url = `https://api.github.com/search/users?q=${locationFilter}type:user+${partition}&sort=repositories&order=desc&per_page=${SEARCH_PER_PAGE}&page=${page}`;

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

    // 422 means we've gone past the 1000-result ceiling for this partition.
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

async function fetchPartitionCandidates(partition, perPartitionTarget, token) {
  const items = [];
  let page = 1;

  while (items.length < perPartitionTarget) {
    const data = await fetchSearchPage(partition, page, token);
    if (!data) break; // exceeded this partition's 1000-result ceiling

    const batch = data.items || [];
    if (batch.length === 0) break;

    items.push(...batch);

    if (items.length >= data.total_count) break;
    page++;

    // Safety: stop if the next page would exceed the per-partition cap.
    if (page > Math.ceil(Math.min(perPartitionTarget, SEARCH_MAX_PAGES * SEARCH_PER_PAGE) / SEARCH_PER_PAGE)) break;
  }

  if (items.length > perPartitionTarget) {
    items.length = perPartitionTarget;
  }

  return items;
}

async function fetchAllSearchResults(token) {
  const perPartitionTarget = Math.ceil(POOL_SIZE / DATE_PARTITIONS.length);
  const seen = new Set(); // dedupe across partitions (accounts can only belong to one partition, but this is a cheap safety net)
  const allItems = [];
  const allLogins = [];

  console.log(`Gathering candidate pool (up to ${POOL_SIZE}) for ${COUNTRY_CODE} (${LOCATION || 'Worldwide'}) across ${DATE_PARTITIONS.length} date partitions...`);

  for (const partition of DATE_PARTITIONS) {
    console.log(`  Partition: ${partition} (target ${perPartitionTarget})`);
    const batch = await fetchPartitionCandidates(partition, perPartitionTarget, token);
    console.log(`    Got ${batch.length} candidates.`);

    for (const item of batch) {
      const login = item.login;
      if (!seen.has(login)) {
        seen.add(login);
        allItems.push(item);
        allLogins.push(login);
      }
    }
  }

  // If partitions still didn't reach POOL_SIZE, trim to what we have.
  if (allItems.length > POOL_SIZE) {
    allItems.length = POOL_SIZE;
  }

  return { items: allItems, usernames: allLogins };
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
      await waitForRateLimitReset(response);
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

  const { items, usernames } = await fetchAllSearchResults(GITHUB_TOKEN);
  console.log(`Candidate pool: ${items.length} unique users.`);

  const targetDir = path.join(__dirname, '..', 'data', COUNTRY_CODE);
  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }

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
