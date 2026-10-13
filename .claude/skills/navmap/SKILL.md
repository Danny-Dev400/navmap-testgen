---
name: navmap
description: Build and incrementally grow a persistent navigation map of a target web app — pages and the semantic actions reachable from each — so another agent can later use it as cheap, precise context for navigating the app. Use when the user asks to map, chart, or build a navigation graph of a web app, or invokes `/navmap`.
---

# /navmap — persistent navigation map

Invocation:

```
/navmap <baseUrl> [creds=<path>] [credsRef=<path>] [context=<path>] [focus=<text>] [maxNewPages=<n>] [maxActionsPerPage=<n>]
```

- `baseUrl` — required, positional. The app to map.
- `creds` — optional path to a credentials JSON file (see **Credentials** below). If omitted, map unauthenticated.
- `credsRef` — optional. The path to *record* as the map's `credentialsRef` when `creds` points at a temporary copy (the dashboard hands headless runs a per-run copy in the project's `.staging/` and denies reading any `credentials/` folder directly). Defaults to `creds`.
- `context` — optional path to a `.md`/`.txt`/`.pdf` describing the business process or domain terms. Read it first if given.
- `focus` — optional free text steering this run, e.g. `focus="checkout flow"`. This is the mechanism for incrementally deepening coverage: point successive `/navmap` runs at specific areas instead of shallowly re-exploring everything each time.
- `maxNewPages` — optional integer, default 25. Budget for genuinely *new* pages discovered this run (re-verifying an already-known page is cheap and not counted against this budget).
- `maxActionsPerPage` — optional integer, default 8. Per-page action budget.

Parse these from the raw `args` string before doing anything else, same as `/explore`.

This skill is independent of `/explore`: `/explore` produces a one-off, per-run workflow+test-plan trace (`projects/<host-slug>/explore/`); `/navmap` produces one persistent, cumulative map per host (`projects/<host-slug>/navmap.json`) that every future `/navmap` run against that host grows further. Don't mix the two artifact shapes.

**Everything for a project lives in `projects/<host-slug>/`** — the map, users, settings, precondition links, screenshots, reports, generated tests, saved sessions and credentials. Deleting that folder resets the project. Never write project files anywhere else.

**This skill only maps.** Its job is a correct map: pages, actions, locators and what was actually observed (checks, form fields, destructive flags, anchors). It never creates, edits or approves test cases (`projects/<host-slug>/cases/`) — those are the test-design layer, made by the user (Test cases tab) or a separate design agent. Re-exploring adds and corrects facts; cases that relied on something that changed get flagged for review automatically.

## Protocol

1. **Compute the host-slug** from `baseUrl`'s hostname (lowercased, non-alphanumeric → `-`). The persistent map lives at `projects/<host-slug>/navmap.json`.

2. **Load the existing map, if any.** If `projects/<host-slug>/navmap.json` exists, read and Zod-parse it against `NavigationMapSchema` ([src/navmap-types.ts](../../../src/navmap-types.ts)). A missing file is the expected empty state for a brand-new host, not an error. A file that exists but fails validation IS an error — stop and report it rather than overwriting it.

3. **If `context` was given**, read it first and let it steer which pages/flows matter.

4. **Build a coverage summary before touching the browser.** This is the token-efficiency step — the whole point of a persistent map is to not re-derive what's already known. For every existing `PageNode`, look at the count and freshness (`timesObserved`, `lastVerifiedAt`, `lastOutcome`) of its outgoing edges (edges in the map where `fromPageId === page.id`). Prioritize, in order:
   a. Known pages with zero or very few outgoing edges (shallow coverage) — explore these first.
   b. If `focus` was given, pages/edges whose `title`/`semanticIntent` textually relate to it.
   c. Only once (a) and (b) are addressed, spend remaining budget (`maxNewPages`) discovering pages not yet in the map at all.
   d. **Skip** re-walking an edge whose `lastVerifiedAt` is within today AND whose `lastOutcome` was `"success"`, unless `focus` explicitly calls out that area. This is the literal mechanism that avoids burning tokens re-exploring already-mapped ground.

5. **If `creds` was given**, read that JSON file (shape: `{ "username", "password", "loginUrl"? }`). Never echo its contents back in any response, commit, or report. Logging in is not a special case here the way it's a dedicated first workflow in `/explore` — it's just an `ActionEdge` like any other, typically from the logged-out landing/home page to a logged-in home/dashboard page, with `intentCategory: "auth"`. Pages that require a session to reach should be marked `requiresAuth: true`.

    Set the staged batch's `credentialsRef` (step 11) to `credsRef` if given, otherwise to the `creds` path itself — just the path, e.g. `"projects/www-saucedemo-com/credentials/saucedemo.json"`, never the file's contents. On that same login `ActionEdge`, also record `authFormLocators: { username, password }` — the structured `locator` for each of the two input fields you actually filled, captured the same way every other `locator` is (step 10). This is separate from the edge's own `locator` (which points at the submit control) and is what lets a later, independent tool drive this exact login mechanically without guessing generic field selectors.

6. **Navigate, using the Playwright MCP tools** (`browser_navigate`, `browser_snapshot`, `browser_click`, `browser_type`, `browser_evaluate`, `browser_take_screenshot`, etc.), staying within `baseUrl`'s origin.
   - **Perform actions only with real input tools** (`browser_click`, `browser_type`, `browser_fill_form`, `browser_select_option`, `browser_press_key`). Never trigger an action through `browser_evaluate` (e.g. `element.click()`) — generated tests use real clicks, so an edge recorded that way is unverified. If real clicks stop having any effect, stop exploring, merge only what you verified, and report it as a tooling problem.

7. **Compute ids via the helper script — never eyeball a slug yourself.** For every URL you land on, run `npm run navmap:id -- page "<url>"` to get the deterministic `{ urlPattern, pageId }`. This is what guarantees the same page gets the same id across separate runs, which is what makes merging correct instead of silently duplicating. Do the same for every action via `npm run navmap:id -- edge <fromPageId> "<semanticIntent>" <toPageId>` to get `{ edgeId }`.

    Only use the `npm run navmap:*` scripts named in this protocol for shell work — no `npx tsx`, `node -e`, `mv` or other ad-hoc commands. Headless runs from the dashboard are only permitted these scripts, so anything else is denied and just wastes a turn.

    Also compute the map's `entryPageId` the same way — run the id helper against `baseUrl` (or `creds`' `loginUrl` if given, since that's the more canonical entry point when the app gates everything behind auth) to get its `pageId`, even if that page isn't otherwise visited this run — and include it as `entryPageId` on this run's staged batch (step 11). It's cheap to recompute every run; the merge step keeps whichever value was set first and ignores every later one, so this never needs special-casing by run or by whether this is a first run.

8. **Identify a "page."** Two URLs are the *same* `PageNode` if they produce the same normalized `urlPattern` (the helper strips query strings and non-routing hash fragments by default, and treats an SPA path-like hash route such as `#/orders/123` as the real route). Only treat a query parameter as distinguishing a genuinely different page when it durably changes which actions are available (e.g. a persistent tab panel) — this should be rare; default to treating query-param variants as the same page.

9. **For each page, record or refresh its `PageNode`**: `title` (a short semantic role, e.g. "Product Detail Page" — not the raw `<title>` tag unless it's already a good semantic label), `requiresAuth` if applicable, up to 5 `sampleUrls`, `notes` for anything non-obvious, and an **`anchor`**: a locator for one element that proves you're on this page and appears on no other page — usually its main heading or title (e.g. `{ strategy: "text", text: "Your Cart", exact: true }`). Generated tests check it on arrival, so a redirect (e.g. an expired session bounced to login) fails with a clear message. Bookkeeping fields (`firstSeenAt`, `lastVerifiedAt`, `timesObserved`, `sourceRunIds`) are handled by the merge step (11) — just set `timesObserved: 1` and `sourceRunIds: [<this run's id>]` for every page/edge you stage this run; the merge script accumulates them correctly across runs.

    **Save the page's accessibility snapshot** the first time you arrive on it this run — only **after confirming you really are on that page** (its URL matches the page's `urlPattern` and its `anchor` is visible; never right after an action whose navigation you haven't verified, or the file ends up holding another page) and **before typing into anything**: call `browser_snapshot` with `filename: projects/<host-slug>/snapshots/<pageId>.yml` (it overwrites the previous one — that's intended). Aria snapshots include textbox values, so never save one after filling a field, and never with credentials typed in. For a page that only shows its real content with prior state (e.g. the checkout overview with items in the cart), save it once that state exists — that's the view later agents need. These files are local observations (gitignored, scrubbed of credentials after each run), not part of the map; later agents read them to find elements the map didn't record without opening a browser.

    Optionally set `group` to a short, human-readable label (e.g. `"Dynamic Catalog"`) shared by every `PageNode` that forms one genuinely cohesive sub-area — pages a user would describe as "the X section," typically reached from one hub page and tightly cross-linked to each other, not merely pages with a similar title or URL prefix. Be conservative: only assign a `group` when at least two pages truly belong together this way; most pages should have no `group` at all. Reuse the exact same `group` string verbatim across every page in that cluster and across runs — before inventing a new label, check whether the existing map already has pages with a `group` value this page should join. Leave `group` unset for any page that doesn't belong to a cluster.

10. **For each meaningful action taken on a page, record an `ActionEdge`.** An action doesn't have to navigate — `toPageId` equals `fromPageId` for in-place actions (filtering, adding to cart without leaving the page, toggling a setting). Before recording:
    - Form `semanticIntent` at the **category level**, never the specific instance acted on (write "Remove item from cart", not "Remove Laptop from cart" — the instance belongs only in `target`/`inputValue`). This is what lets the same action performed on different instances collapse into one edge instead of duplicating.
    - Classify `intentCategory` from the fixed enum: `navigation | auth | search_filter | create | read | update | delete | form_submit | state_toggle | external | other`.
    - Record the structured `locator` your Playwright interaction actually used — pick the strategy matching how you located the element via `browser_snapshot`'s accessibility tree: `role` (`role`, `name?`, `exact?`), `text`, `label`, `placeholder`, `testId`, or `css`.
    - **The locator must match exactly one element.** Check the snapshot for other elements with the same role and name before recording it:
      - **Repeated per item** (e.g. an "Add to cart" button on every product card, a "Remove" on every cart line): keep the inner `locator`, and add `scope: { container, hasText }`. `container` is a locator matching each repeated item (e.g. `{ strategy: "css", css: ".inventory_item" }`); `hasText` is text that singles out the item you acted on (e.g. its product name `"Sauce Labs Backpack"`). Generated code becomes `container.filter({ hasText }).<locator>`.
      - **Duplicated within the same item or page** (e.g. a product's image link and title link share one accessible name): pick a locator that matches only the element you used — a `testId` (note: `getByTestId` reads `data-testid`; for other attributes such as `data-test`, use `css` like `[data-test="item-4-title-link"]`), or a more specific `css`.
    - **Destructive actions**: set `destructive: true` when the action has a real, hard-to-undo side effect — placing or finishing an order, paying, deleting data, sending a message or email, changing account or security settings, publishing something. Tests touching these are excluded from default runs. Leave it unset for anything reversible or local to the session (adding to a cart, filtering, toggling a menu). The user can override your call per action in the dashboard.
    - **Off-origin links** (another domain, e.g. the company site behind an "About" link, social links): set `intentCategory: "external"` and record `external: { url, opensNewTab }` (`url` from the link's href; `opensNewTab` when it has `target="_blank"` or a new tab appeared). Keep `toPageId` equal to `fromPageId`, don't explore the external site, and never add it as a `PageNode`.
    - **Form inputs filled before the action** (e.g. first name, last name and postal code before "Continue"): record each in `formFields: [{ label, locator, value, action? }]` — the field's label, the locator you filled it with, and the test value you typed (`action` is `"fill"` by default, or `"select"`/`"check"`). Use clearly fake test data, never real personal data. **Never put credentials here** — the login form keeps using `authFormLocators` + the credentials file. Without `formFields`, generated tests click submit on an empty form.
    - Optionally set `uiRegion` to a short, human-readable label (e.g. `"navbar"`, `"footer"`, `"checkout-wizard"`, `"cart-modal"`) when this action's target lives inside a structural shell that is genuinely the same reusable chrome across pages — a navbar, footer, modal/dialog, or multi-step wizard frame a user would call "the X" regardless of which page they're on. Be conservative: most actions have no `uiRegion` — only tag it when the surrounding structure is truly the same reused section, not just a similarly-named one that happens to repeat by coincidence. Reuse the exact same `uiRegion` string verbatim across every action in that section and across runs — check the existing map for a `uiRegion` value this action's section should join before inventing a new one. This is what lets several different actions (e.g. a navbar's "Home" link, "Cart" link, and "Logout" link) collapse into one recognized UI component instead of looking like unrelated one-off actions.
    - Record the raw `action`/`target`/`inputValue?` too, for provenance (mirrors `/explore`'s `StepNode` fields).
    - Record `preconditions` (free text, e.g. "cart must contain at least 1 item") and `requiresAuth` if the action needs a session.
    - Record `postconditions` as one or more `{ description, assertionType, check }` entries based on what you actually observed (`assertionType` is the same enum `/explore` uses: `url_matches | text_visible | element_visible | value_equals | status_ok`). **Always add `check`** — the machine-checkable form generated tests assert, taken from the *after* snapshot:
      - `check.kind`: `visible` (something appeared), `hidden` (something disappeared or closed — e.g. a removed cart line, a dismissed error, the cart badge going away), `has_text` (an element shows exact text), `count` (how many of something there are), or `url`.
      - `check.locator`: a locator for **the element the outcome is about** — not the element you clicked (e.g. the cart badge, the destination page's heading, the error banner). Same uniqueness rule as above. Omit only for `url`.
      - `check.value`: only for `has_text` (a string) and `count` (a number), **copied verbatim from the page** — never a paraphrase of the description. If you didn't read the exact value off the page, use `visible`/`hidden` instead.
      - Example: "Remove item from cart" → `{ description: "Cart badge disappears", assertionType: "element_visible", check: { kind: "hidden", locator: { strategy: "css", css: ".shopping_cart_badge" } } }`.
    - Take **two screenshots per edge** (viewport PNGs, no `fullPage`) — a *before* shot with the element being acted on highlighted, and an *after* shot of the result. Both files are overwritten on each re-observation — that's intentional, they're a local debugging aid, not part of the committed map.
      1. Do any preparatory input first (fill the form fields, open the menu, etc.) so the before shot shows the page exactly as it is at the moment of the action. If a menu/drawer just animated open, `browser_wait_for` ~0.5s so the highlight isn't drawn mid-transition.
      2. **Highlight** the element the edge's `locator` points to (the button about to be clicked, the dropdown about to be changed, or — for a fill-only edge — the field just filled) with `browser_evaluate`, passing that element's snapshot ref as `target` and this function verbatim:
         ```js
         (element) => {
           document.getElementById('__navmap_highlight__')?.remove();
           element.scrollIntoView({ block: 'center', inline: 'center' });
           const r = element.getBoundingClientRect();
           const box = document.createElement('div');
           box.id = '__navmap_highlight__';
           Object.assign(box.style, {
             position: 'fixed', left: `${r.left - 4}px`, top: `${r.top - 4}px`,
             width: `${r.width + 8}px`, height: `${r.height + 8}px`, boxSizing: 'border-box',
             border: '3px solid #ff2d55', borderRadius: '6px', background: 'rgba(255,45,85,0.12)',
             boxShadow: '0 0 0 4px rgba(255,45,85,0.25)', pointerEvents: 'none', zIndex: '2147483647',
           });
           document.body.appendChild(box);
           return 'highlighted';
         }
         ```
         It draws a separate fixed-position overlay rather than styling the element, so it can't be clipped by `overflow: hidden` ancestors and doesn't alter the element itself; `pointer-events: none` means it never intercepts the action.
      3. Take the before shot with `filename: projects/<host-slug>/screenshots/_pending.before.png` — the final `edgeId` depends on `toPageId`, which isn't known until the action has happened.
      4. Remove the overlay with `browser_evaluate` and `() => { document.getElementById('__navmap_highlight__')?.remove(); }` (needed for in-place actions; harmless if the page is about to navigate), then perform the action.
      5. Once you know `toPageId` and have computed the `edgeId`, take the after shot with `filename: projects/<host-slug>/screenshots/<edgeId>.png`, and rename the pending file to `projects/<host-slug>/screenshots/<edgeId>.before.png` with `npm run navmap:finalize-shot -- <host-slug> <edgeId>`.
      6. Record both on the edge: `screenshot: "projects/<host-slug>/screenshots/<edgeId>.png"` and `screenshotBefore: "projects/<host-slug>/screenshots/<edgeId>.before.png"`. Omit either field if that capture didn't happen rather than pointing at a missing file.
      - Skip the before shot only for actions with no visible target element (e.g. waiting for a spinner, pressing a key on the page body) — those get just the after shot.
    - Set `lastOutcome` (`success | failed | partial`) based on whether the postconditions actually held.

11. **Stage this run's findings — don't write the persistent map directly.** Assemble a `NavMapRunBatch` (`runId` — get one from `npm run navmap:run-id` — `targetUrl`, `startedAt`, `finishedAt`, `summary`, `entryPageId`, `credentialsRef` if `creds` was given, and the arrays of `PageNode`/`ActionEdge` you touched this run) and write it to `projects/<host-slug>/.staging/<runId>.json`. Then merge it in:
    ```
    npm run navmap:merge -- projects/<host-slug>/.staging/<runId>.json
    ```
    This loads (or creates) `projects/<host-slug>/navmap.json`, upserts by id (new pages/edges inserted as-is; existing ones get their observation counts summed and mutable fields updated — but an incoming sparse/empty field never erases previously-recorded detail), writes it back atomically, and prints a summary of pages/edges added vs. updated. If this fails Zod validation, fix the staged batch and rerun rather than leaving a broken merge.

12. **Render the map**:
    ```
    npm run report:navmap -- <host-slug>
    ```
    Requires `npm run build:map` to have been run at least once, or after any change under `app/` (same shared build the `/explore` map report uses — one `app/dist/index.html` renders either artifact kind).

13. **Report back to the user**: the host-slug, total pages/edges now in the persistent map vs. how many were added/updated this run, and the path to the rendered report. The report is written to `projects/<host-slug>/reports/navmap.html`. Remind the user that `projects/<host-slug>/navmap.json` is tracked in git (unlike the project's `screenshots/`, `reports/` and `tests/`) and worth committing so other sessions/agents benefit from it.

## Credentials

Same shape and handling as `/explore` — see [credentials.example.json.template](../../../credentials.example.json.template). Credentials files live in the project's gitignored `projects/<host-slug>/credentials/` folder and are never committed, and their contents are never echoed back in any output.
