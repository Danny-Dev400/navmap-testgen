---
name: navmap-coverage
description: Generate an initial test-coverage report and runnable Playwright spec skeletons directly from an existing /navmap NavigationMap, with no browser and no new exploration. Use when the user wants test coverage, test cases, or Playwright tests derived from an already-mapped host, or invokes `/navmap-coverage`.
---

# /navmap-coverage — coverage straight from an existing navmap

Invocation:

```
/navmap-coverage <host-slug-or-path-to-navmap.json>
```

- Accepts either a bare host-slug (resolved to `projects/<host-slug>/navmap.json`) or a direct path.

This is **not** an exploration skill — it never opens a browser and never calls any Playwright MCP tool. It's a pure, deterministic transform of a `NavigationMap` that already exists at `projects/<host-slug>/navmap.json` (written by `/navmap`), into:

1. A human-readable HTML coverage report (`npm run report:navmap-coverage`), reusing the exact same report renderer `/explore` uses.
2. Runnable Playwright code (`npm run navmap:generate-tests`) in `projects/<host>/tests/`: Page Object classes (`pages/`), shared UI components (`components/`), one page wrapper per user (`users/`), user fixtures (`fixtures.ts`) — all from the whole map — and one `.spec.ts` per page holding the **approved test cases** that start there.

**Test cases** live in `projects/<host>/cases/<caseId>.json` (committed): each is a list of steps referencing map actions by edge id (plus optional data overrides and which recorded outcomes to check), with a status `draft | approved | rejected`. Only approved cases become tests. The user creates and approves them in the dashboard's Test cases tab; from the CLI, `npm run navmap:cases:baseline -- <host> [--approve]` creates one basic case per action no case covers yet (drafts unless `--approve`). Never create or approve cases unprompted — reviewing them is the user's decision.

**Users** come from `projects/<host>/users.json` (managed in the dashboard's Users tab; committed, contains no secrets — only paths into the project's gitignored `credentials/` folder). Without that file a project gets a `guest` user plus, if the map has a `credentialsRef`, a `default` auth user. Each page's tests run as the guest when it may access the page, otherwise as the first auth user allowed there; a user's page wrapper only exposes the pages it's allowed, so a test can't reach outside that.

## Protocol

1. Resolve the input to a map path. If given a bare host-slug, use `projects/<slug>/navmap.json` (the npm scripts accept the bare id directly). If that file doesn't exist, tell the user to run `/navmap <baseUrl>` first — there's nothing to generate from.
2. Run both commands:
   ```
   npm run report:navmap-coverage -- <path-to-navmap.json>
   npm run navmap:generate-tests -- <path-to-navmap.json>
   ```
   If the project has no test cases yet, the second prints so and writes no specs. Tell the user and offer the two options (baseline drafts to review, or `--approve` to get one test per action right away) instead of picking one.
3. **Report back**: the HTML report path, the `.spec.ts` output directory, and the counts each command printed (pages/test plans; runnable tests vs. `fixme` stubs).
4. Set expectations honestly:
   - Baseline cases are coverage of what the map already recorded — one happy-path action per semantic intent, not boundary/negative/data-variation testing. For deeper exploratory coverage of a specific flow, that's a separate, not-yet-built capability (focused `/explore` driven by the map).
   - Any edge with a remaining real precondition became a `test.fixme(...)` stub, not a real test — the generator doesn't fabricate state setup it can't actually verify. Point the user at those if they ask why a test didn't run.
   - Fixme tests blocked by a precondition can become runnable chained tests once the precondition is linked to the recorded action that sets it up: suggest `/navmap-link-preconditions <host>` (or the "Link preconditions" button in the Test cases tab). Links live in `projects/<host>/precondition-links.json` and are picked up automatically on the next generation.
   - Tests that run as an auth user need that user's saved session (`projects/<host>/.auth/<userId>.json`); until it exists, the fixture skips them with a message saying how to create it. With no auth user at all, tests on login-required pages stay `fixme`.
   - The project's `tests/` and `reports/` folders are gitignored scratch output — regenerate anytime by re-running this skill, nothing to commit.
5. Optionally, if the user wants to actually run the generated specs:
   - If the summary reported auth-dependent tests: `npm run navmap:auth-setup -- <path-to-navmap.json> [--user <id>]` first (or "Set up session" in the Users tab) — this performs a real login against the live site and saves each auth user's session. Mention this only if asked, same caution as below.
   - The login page's own test reads credentials from the user's credentials file at run time (`loadCredentials` in `fixtures.ts`) — no env vars needed, and no secret is ever written into generated code.
   - `npx playwright test` (the root `playwright.config.ts` makes one Playwright project per `projects/<id>/tests/`, e.g. `--project=<host>`; results go to `projects/<host>/test-results/`). Mention this only if asked — running a generated suite against a live site has real side effects (test data created/deleted, a real session created, etc.), so don't do it unprompted.
