import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/unit/**/*.test.ts'],
    environment: 'node',
    // Six suites (file-service-scope, git-actions-integration, git-info, hunk-patch-integration,
    // …) build scratch repos and shell out to REAL git — dozens of process spawns each. Vitest
    // runs test files in parallel, so on a loaded machine those spawns queue and a suite that
    // takes ~0.6 s alone takes >5 s, tripping the 5 s default as a timeout rather than a failed
    // assertion. This is a liveness bound, not a coverage one: no assertion budget changes.
    testTimeout: 20_000,
  },
});
