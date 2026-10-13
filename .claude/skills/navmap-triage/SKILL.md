---
name: navmap-triage
description: Diagnose failed tests of a /navmap project from a dashboard test run — classify each as app bug, test bug or environment, and for test bugs propose the smallest fix in the right layer (a map fact such as a locator, or the test case), which the dashboard then verifies by re-running and the user approves. Use when the user asks why a generated test failed, to triage/repair failing tests, or invokes `/navmap-triage`.
---

# /navmap-triage — why did it fail, and what's the right fix?

Invocation:

```
/navmap-triage <projectId> <runId> <testIndex> [<testIndex> …] [creds=<path> credsRef=<path>]
```

- `runId` / `testIndex` — a run in `projects/<projectId>/runs/<runId>/summary.json` and the failed tests to diagnose (indexes into its `tests`).
- `creds` / `credsRef` — a per-run copy of a test user's credentials, only for logging in through the recorded login form if you need the browser (same rules as `/navmap`).

## What you decide, per failure

- **`app_bug`** — the site itself misbehaves (a server error, a feature that stopped working while the page and locators are fine, a wrong total computed by the app). **No fix** — the test is doing its job. Explain it as a bug report: what was done, what was expected, what happened.
- **`environment`** — not the app and not the test: the site was slow or down, the network failed, a saved session had expired. **No fix**; say whether a plain rerun is the right next step.
- **`test_bug`** — the test is wrong about the app. Propose the **smallest** fix in the right layer:
  - The **map** when a recorded *fact* is wrong or outdated: an action's `locator` / `scope` (list item container), `external` (e.g. the link really opens a new tab: `opensNewTab: true`), its observed `postconditions`; a page's `anchor`; a page element's `locator` / `scope`.
  - The **case** when the *test design* is wrong: an expected value set by the case (`expect`), a check it shouldn't keep (`assert`), data (`item`, `input`, `form`), step order, captures/verifies.
  - Subtypes to use: `locator`, `new_tab`, `assertion`, `data`, `flow`, `timeout`, `session`.

**Never weaken a check just to make a test pass.** If a value changed and you can't tell whether the app is right, or the evidence is unclear, classify without a proposal and explain what a human should check. A fix must be justified by evidence (the page snapshot at failure, a saved snapshot, or what you observed in the browser).

## Protocol

1. For each failure: `npm run navmap:triage-context -- <projectId> <runId> <testIndex>`. JSON with the error, a free rule-based `hint` (a starting point, not a verdict), the generated test, the case's steps with the **map facts they use** (locators included), and `pageSnapshotAtFailure` — the page's accessibility snapshot when it failed.
2. Compare what the test expected with what the page showed. For "what changed", read the saved snapshot from exploration: `npm run navmap:snapshot -- <projectId> <pageId>`.
3. Only if that's not conclusive, **reproduce in the browser**: follow the case's steps with real input tools (`browser_click`, `browser_type`, …) — never trigger actions through `browser_evaluate`. Log in only through the recorded login form with the per-run creds. Never perform a destructive action (finishing an order, paying, deleting) to reproduce — say it couldn't be reproduced safely. When proposing a locator, confirm on the live page that it matches exactly one element (for list items: one per container).
4. Stage the verdicts as a JSON array with the Edit/Write tool at `projects/<projectId>/.staging/triage-<runId>.json`:
   ```json
   [{ "runId": "…", "testIndex": 18, "caseId": "<the test's caseId>",
      "classification": "test_bug", "subtype": "new_tab",
      "explanation": "The Facebook link opens in a new tab, so the original page never navigates; the map recorded opensNewTab: false.",
      "evidence": ["page snapshot at failure is still the Products page", "the link has target=_blank (observed in the browser)"],
      "proposal": { "target": "map", "edgeId": "inventory-html__open-facebook-social-page__inventory-html",
                    "set": { "external": { "url": "https://www.facebook.com/saucelabs", "opensNewTab": true } } } }]
   ```
   Proposal shapes (exactly one per verdict, only for `test_bug`):
   - `{ "target": "map", "edgeId": "…", "set": { "locator"?, "scope"? (or null to remove), "external"?, "postconditions"? } }`
   - `{ "target": "map", "pageId": "…", "elementId"?: "…", "set": { "locator"?, "scope"?, "anchor"? } }`
   - `{ "target": "case", "caseId": "<the failing case>", "steps": [ …the full corrected step list… ] }`
5. `npm run navmap:save-triage -- <projectId> projects/<projectId>/.staging/triage-<runId>.json`. It validates every proposal against copies (the case must stay healthy and generate), and saves **nothing** if something is wrong — fix and re-run.
6. **Report** each verdict in plain words. Say that proposals are now verified automatically by re-running the test with the fix, and wait for the user's approval in the Runs tab. Never edit the map, cases or tests directly, never run tests yourself, never approve anything.
