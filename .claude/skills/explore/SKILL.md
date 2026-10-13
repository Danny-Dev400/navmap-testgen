---
name: explore
description: Explore a target web app with the Playwright MCP server, discover coherent user workflows, generate test plans for them, and render an HTML report. Use when the user asks to explore, test, or audit a web app's workflows, or invokes `/explore`.
---

# /explore — agentic exploratory testing

Invocation:

```
/explore <baseUrl> [creds=<path>] [context=<path>] [maxSteps=<n>]
```

- `baseUrl` — required, positional. The app to explore.
- `creds` — optional path to a credentials JSON file (see **Credentials** below). If omitted, explore unauthenticated.
- `context` — optional path to a `.md`/`.txt`/`.pdf` file describing the business process, priority flows, or domain terms. If given, read it first with the Read tool and use it to decide what's worth exploring.
- `maxSteps` — optional integer overriding the default step budget (default 60).

Parse these from the raw `args` string passed to this skill before doing anything else. `baseUrl` is whatever token isn't of the form `key=value`.

## Protocol

1. **If `context` was given**, read it first. Let it steer which workflows you prioritize and what counts as a meaningful success condition for domain-specific flows.

2. **If `creds` was given**, read that JSON file (shape: `{ "username", "password", "loginUrl"? }`). Never echo its contents back in any response, commit, or report — only use the values to drive the login form. Navigate to `loginUrl` (or `baseUrl` if `loginUrl` is absent), find the actual login fields via `browser_snapshot`, fill them with `browser_type`, submit, and verify success via another `browser_snapshot` — the same real login-flow sequence as any other workflow, not a bypass (e.g. no pre-seeded storage state). Record this as your first `Workflow`.

3. **Explore**, using the Playwright MCP tools (`browser_navigate`, `browser_snapshot`, `browser_click`, `browser_type`, `browser_take_screenshot`, etc.):
   - Stay within `baseUrl`'s origin. Don't follow links out to unrelated external sites.
   - Always act on refs from the *latest* `browser_snapshot` — re-snapshot after any stale-ref error or after navigation.
   - Default budget: ~60 actions total for the whole run (or `maxSteps` if given), with a soft cap of ~15 actions per individual workflow before you wrap it up and move on.
   - If a repeated `(action, target)` pair produces no observable change in the snapshot, stop retrying it — close out that workflow as `partial` or `failed` rather than loop.
   - Group your actions into coherent workflows as you go (e.g. "search for a product", "add item to cart", "submit a contact form") rather than treating every click as its own workflow.
   - Before each step's action, form an explicit expectation of what it should produce — this becomes that step's `expectedResult` (see below). Don't skip this: it's what makes the recorded step a real check rather than just a narrated action.
   - Right after performing a step's action and taking the follow-up `browser_snapshot`, also call `browser_take_screenshot` with `filename: projects/<host-slug>/explore/screenshots/<slug>/<nodeId>.png` (viewport, PNG — omit `fullPage`). `<host-slug>` and `<slug>` are defined in step 6; `<nodeId>` is the step node's own id (step 4).
   - **Look for and deliberately explore shared prefixes.** If a site has related workflows that start the same way (e.g. an e-commerce site's "buy a product" and "remove a product from the cart" both start with "add item to cart"), explore them together in this same run so the shared steps can be recorded once and reused (step 4) — don't treat every workflow as fully independent if it plainly shares real steps with one you've already walked.

4. **Steps are shared nodes, not per-workflow copies.** Every step you perform is recorded once in the run's `stepNodes` dictionary, keyed by a stable id (kebab-case, e.g. `add-item-to-cart`). A `Workflow` doesn't embed its steps — it's just an ordered list of node ids (`stepIds`) that happen to point into that shared dictionary. Concretely:
   - Before recording a new step, check whether an identical one (same `action` + `target` + `expectedResult`) already exists in this run's `stepNodes`. If so, **reuse its id** in the current workflow's `stepIds` — don't create a duplicate node. This is exactly how two related workflows fork from a shared ancestor: both list the same node id(s) at the start of their `stepIds`, then diverge.
   - If it's genuinely new, add it to `stepNodes` with: `id`, `action`, `target`, `inputValue?`, `url?`, `expectedResult` (the expectation you formed before acting), `observedResult` (what actually happened), `matchedExpectation` (`true`/`false`), and `screenshot` (the `projects/<host-slug>/explore/screenshots/<slug>/<nodeId>.png` path just captured).
   - Each `Workflow` object (matching `WorkflowSchema` in [src/types.ts](../../../src/types.ts)) is then just `id` (kebab-case slug of the title), `title`, `status` (`success` | `partial` | `failed`), and `stepIds` (the ordered list of node ids it walks, shared ones included).

5. **After exploring, derive a `TestPlan` per workflow** matching `TestPlanSchema`: `id`, `workflowId`, `title`, `preconditions`, and ordered `steps` each with `order`, `action`, `target`, `inputData?`, `expectedAssertion`, `assertionType` (`url_matches` | `text_visible` | `element_visible` | `value_equals` | `status_ok`), and — when a test plan step maps directly to one recorded step node (not a synthesized observational assertion) — that node's id as `sourceStepId` (this is how the step's screenshot and the test plan's assertion stay linked without duplicating data). Base assertions on what you actually observed, not guesses.

6. **Assemble the full `ExplorationRun`** (`id`, `targetUrl`, `startedAt`, `finishedAt`, `summary`, `stepNodes`, `workflows`, `testPlans`) and write it to `projects/<host-slug>/explore/<slug>.json`, where `host-slug` is `baseUrl`'s hostname lowercased with every non-alphanumeric character replaced by `-` (the project id, e.g. `the-internet-herokuapp-com`) and `slug` is the host-slug plus today's date (e.g. `the-internet-herokuapp-com-2026-10-03`). Everything for a project lives in `projects/<host-slug>/` — never write run files anywhere else. If a file for that slug already exists today, append `-2`, `-3`, etc. Screenshots for the run live alongside it under `projects/<host-slug>/explore/screenshots/<slug>/`.

7. **Render both reports**:
   - `npm run report -- projects/<host-slug>/explore/<slug>.json projects/<host-slug>/reports/explore-<slug>.html` — the flat, linear report (Zod-validates against `ExplorationRunSchema`, inlines every referenced screenshot as a base64 data URI).
   - `npm run report:map -- projects/<host-slug>/explore/<slug>.json projects/<host-slug>/reports/explore-<slug>-map.html` — the interactive mind-map view (pan/zoom/drag canvas; click a node to see its full detail, screenshot, which workflows use it, and which test-plan assertions derive from it). Requires `npm run build:map` to have been run at least once, or after any change under `app/`.
   If either fails validation, fix the JSON and rerun rather than leaving a broken result file.

8. Report back to the user: the slug, how many workflows/step nodes/test plans were found, and the paths to both rendered reports.

## Credentials

Credentials files live in the project's gitignored `projects/<host-slug>/credentials/` folder and are never committed. See [credentials.example.json.template](../../../credentials.example.json.template) for the shape. A client preparing to run `/explore` against their own app should copy that template to `projects/<host-slug>/credentials/<name>.json`, fill in real values, and pass `creds=projects/<host-slug>/credentials/<name>.json`.
