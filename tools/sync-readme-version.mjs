// Keep the version reference(s) in README.md in sync with package.json.
//
// Wired as the npm `version` lifecycle script, so it runs during `npm version`
// (and therefore `npm run release`) after package.json is bumped but before the
// version commit — the README change rides along in that commit. The "Version"
// badge in the README is a dynamic shields.io GitHub-release badge and needs no
// syncing; this only updates the `vX.Y.Z` prose token(s).

import { readFileSync, writeFileSync } from 'node:fs';

const { version } = JSON.parse(readFileSync('package.json', 'utf8'));
const path = 'README.md';
const before = readFileSync(path, 'utf8');
// Replace backtick-wrapped semver tokens like `v0.1.3` with the current version.
const after = before.replace(/`v\d+\.\d+\.\d+`/g, `\`v${version}\``);

if (after !== before) {
  writeFileSync(path, after);
  console.log(`sync-readme-version: README.md → v${version}`);
} else {
  console.log(`sync-readme-version: README.md already at v${version}`);
}
