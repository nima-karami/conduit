/**
 * The stress fixture for the text-fit sweep: every name the UI prints is as long, as deep, or as
 * unbreakable as a real project can make it. A long repo folder, deep directory chains, filenames
 * with no break opportunity and non-ASCII ones, a long branch, long commit subjects and authors,
 * staged + unstaged + untracked changes across many files, a second repo to attach, a board with
 * long titles and tickets, long Markdown headings for the TOC, an interactive plan and an
 * architecture doc with long component names.
 *
 * Lives in os.tmpdir() and is rebuilt per sweep, so every pass starts from the same bytes.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ARCH_FIXTURE_DOC } from './fixture-repo.mjs';

const BASE = join(tmpdir(), 'conduit-textfit');
const REPO_NAME = 'customer-reservation-platform-booking-experience-monorepo';
const ATTACHED_NAME = 'shared-design-tokens-and-component-library-for-every-product-surface';
const BRANCH = 'feature/JIRA-12345-a-very-long-branch-name-that-keeps-going-and-going';
const AUTHOR = 'Maximilian Alexander Konstantinos Papadopoulos-Worthington III';
export const NOSPACE_FILE =
  'averyveryverylongfilenamewithoutanyspaces_component_implementation.test.tsx';
const DEEP_DIR = 'packages/reservation-management/src/booking-confirmation-summary';
const LONG_MD = 'docs/ARCHITECTURE-DECISIONS-AND-DESIGN-NOTES-FOR-THE-BOOKING-PLATFORM.md';
// At the 64-character cap of PLAN_SLUG_RE (src/plan-path.ts): as long as a plan name can be.
const PLAN_SLUG = 'migrate-the-reservation-service-to-the-event-sourced-ledger-arch';

// Every commit gets the next fixed timestamp, so SHAs — which the UI prints and finding ids hash —
// are identical on every rebuild, and a BEFORE and an AFTER sweep see the same history.
let clock = Date.parse('2026-01-15T09:00:00Z') / 1000;
const git = (cwd, ...args) => {
  clock += 3600;
  const date = `${clock} +0000`;
  return execFileSync('git', args, {
    cwd,
    stdio: 'pipe',
    encoding: 'utf8',
    env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
  }).trim();
};

const write = (root, rel, body) => {
  const abs = join(root, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, body);
};

const initRepo = (root, branch) => {
  mkdirSync(root, { recursive: true });
  git(root, 'init', '-q', '-b', branch);
  git(root, 'config', 'user.email', 'maximilian.papadopoulos-worthington@reservations.example.com');
  git(root, 'config', 'user.name', AUTHOR);
  git(root, 'config', 'commit.gpgsign', 'false');
  git(root, 'config', 'core.autocrlf', 'false');
  git(root, 'config', 'core.longpaths', 'true');
};

// Board/architecture timestamps are fixed for the same reason commit dates are: byte-identical
// artifacts on every rebuild.
const STAMP = Date.parse('2026-09-01T12:00:00Z');

const LONG_IDENT = 'computeBookingConfirmationSummaryWithItineraryDetailsAndLoyaltyAdjustments';

const TS_LIB = `/** Totals, taxes and loyalty adjustments for a confirmed booking, rendered in the summary panel. */
export interface BookingConfirmationSummaryWithItineraryDetails {
  reservationIdentifierForCustomerFacingCommunication: string;
  passengerDisplayNamesInBookingOrder: readonly string[];
  totalAmountIncludingTaxesAndFeesInMinorCurrencyUnits: number;
}

export function ${LONG_IDENT}(
  reservationIdentifierForCustomerFacingCommunication: string,
  passengerDisplayNamesInBookingOrder: readonly string[],
): BookingConfirmationSummaryWithItineraryDetails {
  return {
    reservationIdentifierForCustomerFacingCommunication,
    passengerDisplayNamesInBookingOrder,
    totalAmountIncludingTaxesAndFeesInMinorCurrencyUnits: 0,
  };
}
`;

const TS_USE = (n) => `import { ${LONG_IDENT} } from './booking-confirmation-summary';

export const summaryForTheLongestPossibleItineraryVariant${n} = ${LONG_IDENT}(
  'RES-${1000 + n}-CONFIRMED',
  ['Alexandra Konstantinopoulou', 'Bartholomew Fitzgerald-Hawthorne'],
);

export function describeSummaryVariant${n}() {
  const summary = summaryForTheLongestPossibleItineraryVariant${n};
  return summary.passengerDisplayNamesInBookingOrder.join(', ');
}
`;

const LONG_HEADINGS = `# Architecture decisions and design notes for the booking platform modernization

This document records every decision the booking platform team made while moving the reservation
flow off the monolith.

## 1. Why the reservation service owns the itinerary aggregate and nothing else touches it directly

Text.

### 1.1 Consequences for the loyalty programme integration and the partner airline settlement batch

Text.

#### A deliberately long fourth-level heading that exists only to stress the table of contents indentation

Text.

## 2. Supercalifragilisticexpialidocious_identifier_without_any_break_opportunity_at_all_in_the_heading

Text.

## 3. Überprüfung der Buchungsbestätigung — 予約確認の概要と旅程の詳細 — résumé des étapes

Text.

## 4. Short

Text.

${Array.from({ length: 12 }, (_, i) => `## ${5 + i}. Operational runbook section number ${5 + i} covering failover, retries and the dead-letter queue\n\nText.\n`).join('\n')}
`;

const PLAN_MD = `---
title: Migrate the reservation service to the event-sourced ledger architecture without downtime
---

# Migrate the reservation service to the event-sourced ledger architecture without downtime

The reservation service writes to the relational store today. This plan moves every write through
the ledger while the read models keep serving traffic.

## Step 1 — Dual-write every reservation mutation to the ledger and the legacy tables behind a flag

\`\`\`ts
export function ${LONG_IDENT}Ledger(input: { reservationIdentifierForCustomerFacingCommunication: string }): Promise<void>
\`\`\`

## Step 2 — Backfill_the_historical_reservations_into_the_ledger_with_idempotent_replay_markers

Replay is idempotent because every event carries its source row version.
`;

const card = (id, title, notes, stage, ticket) => ({
  id,
  title,
  notes,
  stage,
  createdAt: STAMP - 9 * 86_400_000,
  updatedAt: STAMP - 2 * 86_400_000,
  ...(ticket ? { ticket } : {}),
});

const BOARD = {
  conduit: 1,
  kind: 'board',
  updatedAt: STAMP,
  data: {
    version: 1,
    cards: [
      card(
        'c1',
        'Migrate the reservation service to the event-sourced ledger architecture without downtime',
        'Dual-write, backfill, cut over. Every step behind a flag so rollback is a config change.',
        'wishlist',
        {
          key: 'BOOKINGPLATFORM-123456',
          source: 'Jira Service Management Cloud',
          status: 'Waiting for customer approval',
        },
      ),
      card(
        'c2',
        'Supercalifragilisticexpialidocious_card_title_without_any_spaces_to_break_on_whatsoever',
        'averyveryverylongnotewithoutanyspacesthatshouldwrapsomewhereinsidethecardbodyinsteadofoverflowing',
        'wishlist',
      ),
      card(
        'c3',
        'Überprüfung der Buchungsbestätigung — 予約確認の概要と旅程の詳細を表示する',
        'Non-ASCII titles must wrap and measure the same as ASCII ones.',
        'planning',
        { key: 'CON-98765', source: 'Linear', status: 'In progress' },
      ),
      card('c4', 'Short', 'A short card beside long ones.', 'planning'),
      card(
        'c5',
        'Make the booking confirmation summary component render the itinerary details for multi-leg trips',
        'Linked to two sessions with long names so the session rows under the card are stressed too.',
        'building',
        {
          key: 'RESERVATIONS-4242',
          source: 'GitHub Issues',
          status: 'Needs review from the platform team',
        },
      ),
      card(
        'c6',
        'Retire the legacy settlement batch job and its nightly cron schedule',
        '',
        'done',
      ),
    ],
  },
};

const longArch = () => {
  const doc = structuredClone(ARCH_FIXTURE_DOC);
  const names = {
    agent: 'External reservation partner integration gateway',
    model: 'BookingConfirmationSummaryWithItineraryDetailsAggregate',
    canvas: 'Customer-facing booking experience web application',
    host: 'Reservation ledger event-sourcing service',
    file: '.conduit/architecture-of-the-booking-platform.json',
    undo: 'Überprüfung / 予約確認 audit trail',
  };
  for (const n of doc.graphs.root.nodes) {
    n.title = names[n.id] ?? n.title;
    n.subtitle = `${n.subtitle} — with a subtitle long enough to need truncating somewhere`;
  }
  return { conduit: 1, kind: 'architecture', updatedAt: STAMP, data: doc };
};

/**
 * Build the stress fixture from scratch.
 * @returns {{ base: string, repo: string, attached: string, plain: string, plan: { dir: string, file: string, body: string } }}
 */
export function buildStressFixture() {
  clock = Date.parse('2026-01-15T09:00:00Z') / 1000;
  try {
    rmSync(BASE, { recursive: true, force: true });
  } catch {
    // A previous sweep's app can still hold a watch handle; the rebuild below overwrites anyway.
  }
  const repo = join(BASE, REPO_NAME);
  const attached = join(BASE, ATTACHED_NAME);
  const plain = join(BASE, 'plain-folder-without-git-for-the-idle-session-state');
  mkdirSync(plain, { recursive: true });
  writeFileSync(join(plain, 'notes.txt'), 'idle\n');

  // ── main repo ──
  initRepo(repo, 'main');
  write(repo, 'README.md', '# Booking platform\n\nThe customer reservation platform monorepo.\n');
  write(repo, '.gitignore', 'node_modules\n');
  write(repo, 'package.json', '{\n  "name": "booking-platform",\n  "private": true\n}\n');
  write(
    repo,
    'tsconfig.json',
    '{\n  "compilerOptions": { "strict": true, "jsx": "react-jsx" }\n}\n',
  );
  write(repo, `${DEEP_DIR}/booking-confirmation-summary.ts`, TS_LIB);
  for (let i = 1; i <= 4; i++) {
    write(repo, `${DEEP_DIR}/booking-confirmation-summary-variant-${i}.ts`, TS_USE(i));
  }
  write(repo, `${DEEP_DIR}/${NOSPACE_FILE}`, TS_USE(9));
  write(
    repo,
    `${DEEP_DIR}/résumé-überprüfung-予約確認の概要-configuration.ts`,
    'export const überprüfung = true;\n',
  );
  write(repo, LONG_MD, LONG_HEADINGS);
  write(repo, 'docs/CHANGELOG.md', '# Changelog\n\n## 1.0.0\n\n- first cut\n');
  write(repo, '.conduit/board.json', JSON.stringify(BOARD, null, 2));
  write(repo, '.conduit/architecture.json', JSON.stringify(longArch(), null, 2));
  git(repo, 'add', '-A');
  git(
    repo,
    'commit',
    '-qm',
    'chore: scaffold the booking platform monorepo with its first packages',
  );

  const subjects = [
    'feat(booking-confirmation): render the itinerary details for multi-leg trips including layovers, fare classes and loyalty adjustments',
    'fix(reservations): stop the settlement batch from double-counting refunds when a partner airline sends the same cancellation twice',
    'refactor: Supercalifragilisticexpialidocious_commit_subject_without_any_spaces_to_break_on',
    'docs: Überprüfung der Buchungsbestätigung — 予約確認の概要と旅程の詳細',
    'chore: short',
  ];
  subjects.forEach((msg, i) => {
    write(
      repo,
      `${DEEP_DIR}/booking-confirmation-summary-variant-${(i % 4) + 1}.ts`,
      `${TS_USE(i + 1)}// rev ${i}\n`,
    );
    git(repo, 'add', '-A');
    git(
      repo,
      '-c',
      `user.name=${i % 2 ? 'Bartholomew Fitzgerald-Hawthorne of the Platform Reliability Guild' : AUTHOR}`,
      'commit',
      '-qm',
      msg,
      '-m',
      'A body paragraph that is long enough to wrap several times inside the commit detail pane, so the message block is exercised as well as the subject line. '.repeat(
        3,
      ),
    );
  });
  git(repo, 'tag', 'v2026.09.25-release-candidate-with-a-long-tag-name');
  git(repo, 'checkout', '-q', '-b', BRANCH);
  write(repo, `${DEEP_DIR}/booking-confirmation-summary.ts`, `${TS_LIB}\n// branch work\n`);
  git(repo, 'add', '-A');
  git(
    repo,
    'commit',
    '-qm',
    'wip: branch work on the booking confirmation summary for the release candidate',
  );

  // Dirty worktree: staged, unstaged, untracked, deleted — across many long-named files.
  for (let i = 1; i <= 4; i++) {
    write(
      repo,
      `${DEEP_DIR}/booking-confirmation-summary-variant-${i}.ts`,
      `${TS_USE(i)}// unstaged edit ${i}\n`,
    );
  }
  write(repo, `${DEEP_DIR}/${NOSPACE_FILE}`, `${TS_USE(9)}// staged\n`);
  git(repo, 'add', `${DEEP_DIR}/${NOSPACE_FILE}`);
  for (let i = 1; i <= 6; i++) {
    write(
      repo,
      `packages/untracked-feature-flag-evaluation-engine-for-gradual-rollouts/src/rule-evaluator-with-percentage-bucketing-${i}.ts`,
      `export const bucket${i} = ${i};\n`,
    );
  }
  write(repo, 'Ünïcödé Fïlé Nämé With Spaces And Accents — 予約.md', '# Unicode\n');
  git(repo, 'rm', '-q', 'docs/CHANGELOG.md');

  // Plans dir must exist before the project opens (electron/plan-watcher.ts `arm`).
  const planDir = join(repo, '.conduit', 'plans');
  mkdirSync(planDir, { recursive: true });

  // ── attached repo ──
  initRepo(attached, 'release/2026.09-shared-design-tokens-and-component-library-hotfix');
  write(attached, 'tokens/color-palette-semantic-aliases-for-dark-and-light-surfaces.json', '{}\n');
  write(attached, 'README.md', '# Tokens\n');
  git(attached, 'add', '-A');
  git(
    attached,
    'commit',
    '-qm',
    'feat(tokens): semantic aliases for every surface the booking platform renders on',
  );
  write(
    attached,
    'tokens/color-palette-semantic-aliases-for-dark-and-light-surfaces.json',
    '{ "a": 1 }\n',
  );
  write(attached, 'components/button-with-leading-icon-and-trailing-badge.tsx', 'export {};\n');

  return {
    base: BASE.replace(/\\/g, '/'),
    repo: repo.replace(/\\/g, '/'),
    attached: attached.replace(/\\/g, '/'),
    plain: plain.replace(/\\/g, '/'),
    plan: { dir: planDir, file: join(planDir, `${PLAN_SLUG}.md`), body: PLAN_MD },
  };
}
