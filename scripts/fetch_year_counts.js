const { resolveCountry, validCountryCodes } = require('./lib/config');
const { refreshCountry } = require('./lib/count-service');

const COUNTRY_CODE = process.argv[2] || 'LK';

function main() {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    console.error('Error: GITHUB_TOKEN environment variable is required for the GitHub API.');
    console.error('Set it with: export GITHUB_TOKEN=your_token');
    process.exit(1);
  }

  const { countryCode, config } = resolveCountry(COUNTRY_CODE);
  if (!config) {
    console.error(
      `Error: Unknown country code '${countryCode}'. ` +
      `Valid codes: ${validCountryCodes().join(', ')}`
    );
    process.exit(1);
  }

  return refreshCountry({
    countryCode,
    location: config.location,
    token
  });
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
