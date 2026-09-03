const fs = require('fs');
const path = require('path');

const BATCH_SIZE = 50;
const SEARCH_PER_PAGE = 100;
const GRAPHQL_URL = 'https://api.github.com/graphql';

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

function buildGraphQLQuery(usernames) {
  const fields = usernames.map((username, i) =>
    `_${i}: user(login: "${username}") {
      login
      name
      followers { totalCount }
    }`
  ).join('\n');
  return `{
    rateLimit { cost remaining resetAt }
    ${fields}
  }`;
}

async function fetchSearchPage(page, token) {
  const url = `https://api.github.com/search/users?q=location:"${encodeURIComponent(LOCATION)}"+type:user&sort=followers&order=desc&per_page=${SEARCH_PER_PAGE}&page=${page}`;

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
      await new Promise(r => setTimeout(r, retryAfter * 1000));
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

  console.log(`Fetching user list for ${COUNTRY_CODE} (${LOCATION}) from search API (paginated)...`);

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

  // Trim to requested total
  if (allItems.length > MAX_USERS) {
    allItems.length = MAX_USERS;
  }

  return allItems;
}

async function fetchUserData(usernames, token) {
  const userData = {};
  for (let i = 0; i < usernames.length; i += BATCH_SIZE) {
    const batch = usernames.slice(i, i + BATCH_SIZE);

    let result;
    for (let attempt = 1; attempt <= 5; attempt++) {
      const query = buildGraphQLQuery(batch);
      const response = await fetch(GRAPHQL_URL, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ query })
      });

      if (response.status === 403 || response.status === 429) {
        const retryAfter = response.headers.get('Retry-After') || 60;
        console.log(`    Rate limited. Waiting ${retryAfter}s (attempt ${attempt}/5)...`);
        await new Promise(r => setTimeout(r, retryAfter * 1000));
        continue;
      }

      if (!response.ok) {
        const err = await response.text();
        throw new Error(`GraphQL API error: ${response.status} ${err}`);
      }

      result = await response.json();
      break;
    }

    if (!result) {
      throw new Error('GraphQL rate limit exceeded after retries.');
    }

    if (result.errors && result.errors.some(e => e.type === 'RATE_LIMITED')) {
      console.log('    GraphQL rate limit hit. Waiting 60s...');
      await new Promise(r => setTimeout(r, 60000));
      i -= BATCH_SIZE;
      continue;
    }

    // Monitor remaining quota
    if (result.data && result.data.rateLimit) {
      const { remaining, resetAt } = result.data.rateLimit;
      const cooldownMs = Math.max(0, new Date(resetAt).getTime() - Date.now());
      console.log(`    Remaining GraphQL points: ${remaining}`);
      if (remaining < 500) {
        console.log(`    Low quota (${remaining}). Waiting until reset ${resetAt} (${Math.round(cooldownMs / 1000)}s)...`);
        await new Promise(r => setTimeout(r, cooldownMs + 5000));
        i -= BATCH_SIZE;
        continue;
      }
    }

    for (const key of Object.keys(result.data || {})) {
      const user = result.data[key];
      if (user && user.login) {
        userData[user.login.toLowerCase()] = {
          name: user.name || null,
          followers_count: user.followers ? user.followers.totalCount : null
        };
      }
    }

    console.log(`  Fetched user data for batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(usernames.length / BATCH_SIZE)}`);
  }
  return userData;
}

async function updateTopFollowers() {
  const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

  if (!GITHUB_TOKEN) {
    console.error('Error: GITHUB_TOKEN environment variable is required for GraphQL API.');
    console.error('Set it with: export GITHUB_TOKEN=your_token');
    process.exit(1);
  }

  const items = await fetchAllSearchResults(GITHUB_TOKEN);
  console.log(`Found ${items.length} users. Fetching accurate followers counts via GraphQL...`);

  const usernames = items.map(u => u.login);
  const userData = await fetchUserData(usernames, GITHUB_TOKEN);

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
  console.log(`Saved successfully to ${targetFilePath}`);
}

updateTopFollowers().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
