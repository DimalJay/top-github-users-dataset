const fs = require('fs');
const path = require('path');

const BATCH_SIZE = 50;
const GRAPHQL_URL = 'https://api.github.com/graphql';
const SEARCH_URL = 'https://api.github.com/search/users?q=location:"Sri+Lanka"+type:user&sort=followers&order=desc&per_page=100';

function buildGraphQLQuery(usernames) {
  const fields = usernames.map((username, i) =>
    `_${i}: user(login: "${username}") {
      login
      name
      followers { totalCount }
    }`
  ).join('\n');
  return `{ ${fields} }`;
}

async function fetchUserData(usernames, token) {
  const userData = {};
  for (let i = 0; i < usernames.length; i += BATCH_SIZE) {
    const batch = usernames.slice(i, i + BATCH_SIZE);
    const query = buildGraphQLQuery(batch);

    const response = await fetch(GRAPHQL_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ query })
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`GraphQL API error: ${response.status} ${err}`);
    }

    const result = await response.json();
    if (result.errors) {
      throw new Error(`GraphQL errors: ${JSON.stringify(result.errors)}`);
    }

    for (const key of Object.keys(result.data)) {
      const user = result.data[key];
      if (user) {
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

  console.log('Fetching user list from search API...');

  const searchResponse = await fetch(SEARCH_URL, {
    headers: {
      'Accept': 'application/vnd.github.v3+json',
      'User-Agent': 'Node-Fetch-Script',
      'Authorization': `Bearer ${GITHUB_TOKEN}`
    }
  });

  if (!searchResponse.ok) {
    throw new Error(`Search API error: ${searchResponse.status} ${searchResponse.statusText}`);
  }

  const searchData = await searchResponse.json();
  const items = searchData.items || [];

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

  const targetDir = path.join(__dirname, '..', 'data', 'LK');
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
