const fs = require('fs');
const path = require('path');

const SEARCH_PER_PAGE = 100;
const REST_DELAY_MS = 250; // ~4 req/sec, still safely under the 5000/hr core quota
const REST_API = 'https://api.github.com/users';

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

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function fetchSearchPage(page, token) {
  const locationFilter = LOCATION ? `location:"${encodeURIComponent(LOCATION)}"+` : '';
  const url = `https://api.github.com/search/users?q=${locationFilter}type:user&sort=followers&order=desc&per_page=${SEARCH_PER_PAGE}&page=${page}`;

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

  console.log(`Fetching user list for ${COUNTRY_CODE} (${LOCATION || 'Worldwide'}) from search API (paginated)...`);

  while (allItems.length < MAX_USERS) {
    console.log(`  Fetching search page ${page}...`);
    const data = await fetchSearchPage(page, token);
    const items = data.items || [];

    if (items.length === 0) break;
    allItems.push(...items);

    if (allItems.length >= data.total_count) break;
    page++;

    if (page > Math.ceil(MAX_USERS / SEARCH_PER_PAGE)) break;
  }

  if (allItems.length > MAX_USERS) {
    allItems.length = MAX_USERS;
  }

  return allItems;
}

async function fetchUserData(usernames, token, progressFile) {
  const userData = {};

  if (fs.existsSync(progressFile)) {
    try {
      const existing = JSON.parse(fs.readFileSync(progressFile, 'utf-8'));
      if (existing && Array.isArray(existing)) {
        for (const entry of existing) {
          userData[entry.username.toLowerCase()] = {
            name: entry.name ?? null,
            followers_count: entry.followers_count ?? null
          };
        }
        console.log(`  Resuming from existing progress (${Object.keys(userData).length} users already fetched).`);
      }
    } catch (e) {
      console.log('  Could not load progress file, starting fresh.');
    }
  }

  const todo = usernames.filter(u => !userData[u.toLowerCase()]);
  console.log(`  Fetching accurate follower counts for ${todo.length} users via REST...`);

  let fetched = Object.keys(userData).length;

  for (const username of todo) {
    let data;
    let resolved = false;
    for (let attempt = 1; attempt <= 5; attempt++) {
      const response = await fetch(`${REST_API}/${encodeURIComponent(username)}`, {
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

      if (response.status === 404) {
        data = null;
        resolved = true;
        break;
      }

      if (!response.ok) {
        const err = await response.text();
        throw new Error(`REST API error (${username}): ${response.status} ${err}`);
      }

      data = await response.json();
      resolved = true;
      break;
    }

    if (!resolved) {
      throw new Error(`REST rate limit exceeded after retries (${username}).`);
    }

    userData[username.toLowerCase()] = {
      name: data ? (data.name || null) : null,
      followers_count: data ? (data.followers ?? null) : null
    };

    fetched++;
    fs.writeFileSync(progressFile, JSON.stringify(
      Object.entries(userData).map(([u, e]) => ({ username: u, name: e.name, followers_count: e.followers_count })),
      null, 2
    ));

    if (fetched % 50 === 0) {
      console.log(`  Fetched ${fetched}/${usernames.length} users...`);
    }

    await sleep(REST_DELAY_MS);
  }

  return userData;
}

async function updateTopFollowers() {
  const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

  if (!GITHUB_TOKEN) {
    console.error('Error: GITHUB_TOKEN environment variable is required for the GitHub API.');
    console.error('Set it with: export GITHUB_TOKEN=your_token');
    process.exit(1);
  }

  const items = await fetchAllSearchResults(GITHUB_TOKEN);
  console.log(`Found ${items.length} users.`);

  const progressFile = path.join(__dirname, '..', 'data', COUNTRY_CODE, '_progress.json');
  const usernames = items.map(u => u.login);
  const userData = await fetchUserData(usernames, GITHUB_TOKEN, progressFile);

  const formattedUsers = items.map((user, index) => {
    const data = userData[user.login.toLowerCase()] || {};
    return {
      rank: index + 1,
      name: data.name ?? null,
      username: user.login,
      avatar_url: user.avatar_url,
      profile_url: user.html_url,
      id: user.id,
      followers_count: data.followers_count ?? null
    };
  });

  const outputData = {
    last_updated: new Date().toISOString(),
    total_count: formattedUsers.length,
    users: formattedUsers
  };

  const targetDir = path.join(__dirname, '..', 'data', COUNTRY_CODE);
  const targetFilePath = path.join(targetDir, 'top_users_followers.json');

  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }

  fs.writeFileSync(targetFilePath, JSON.stringify(outputData, null, 2));
  fs.unlinkSync(progressFile);
  console.log(`Saved successfully to ${targetFilePath}`);
}

updateTopFollowers().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
