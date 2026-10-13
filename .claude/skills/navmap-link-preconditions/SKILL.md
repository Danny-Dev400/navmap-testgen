---
name: navmap-link-preconditions
description: Link each precondition of a /navmap project's actions to a named state ("Cart has items", "Side menu open") with a reusable flow that produces it — reusing existing states first — and ask the human whatever can't be resolved from the map, so generated tests chain their setup instead of staying fixme. Use when the user wants to reduce fixme tests, link/resolve preconditions or states, or invokes `/navmap-link-preconditions`.
---

# /navmap-link-preconditions — the state linker

Invocation:

```
/navmap-link-preconditions <projectId> [verify=true]
```

- `projectId` — the host slug, e.g. `www-saucedemo-com` (the map is `projects/<projectId>/navmap.json`).
- `verify=true` — optional. After saving, run the newly runnable tests against the **live site** to check the flows. Off by default because flows can have real side effects (a "Place order" step places a real order). Never verify unless it was asked for.

## What you're producing

Every action precondition (free text recorded by `/navmap`, e.g. "cart must contain at least 1 item") must point to a **state** — a named situation with a **flow**: the recorded actions that put the app in it. A state is described once and reused by every action and test case that needs it; the planner solves chains over states and generates each persistent flow as a reusable function. You never edit generated code, the map, test cases, or `states.json` directly — only through the save scripts.

**State kinds you may create:**
- **`persistent`** — survives navigation because it lives in the session or on the server: cart contents, a submitted form, a created record, a completed order. Its flow runs on its own pages, then the test navigates on.
- **`transient`** — exists only on the page where it was created and is lost on navigation: an open menu/drawer/dropdown/modal, an expanded submenu, a shown validation message, typed-but-unsubmitted input. Its flow runs on the page that needs it, with no navigation in between — so its steps must not navigate, and an action recorded on another page only works if it's a shared UI component (`uiRegion`) the map saw on that page too.

**Never** decide on your own that a state is *already true at the start*, needs a *specific user*, or *can't be automated* — those are the human's answers. Suggest them in a question (below).

**`perItem` / `sameItem`:** a state whose flow acts on a list item (e.g. "Add item to cart" with `listItem: "Sauce Labs Backpack"`) is `perItem: true`. A binding with `sameItem: true` makes that flow act on **the consumer action's own item** ("remove product X" needs "product X is in the cart"). Only valid when both the consumer and a flow step act on a list item.

## Protocol

1. Run `npm run navmap:state-candidates -- <projectId>`. It prints JSON:
   - `pending` — each precondition not linked to a state yet: action id, page, intent, the precondition text, whether the action acts on a list item, and the user its test runs as.
   - `states` — the existing states: id, title, kind, flow, perItem, status (`ok`, `needs_answer`, `cant_run_here`, `not_automatable`), the preconditions already bound to them, notes.
   - `candidates` — every recorded action, with its page, intent, `navigatesTo`, `uiRegion`, list item, own preconditions and postconditions.
   - `pages`, `users`, `openQuestions` (already asked — don't ask them again).

   Don't read the raw map. If `pending` is empty and no state lacks a flow that a recorded action could now provide, report that and stop.
2. For each pending precondition:
   - **Reuse first.** If an existing state means the same thing — even worded differently ("cart must not be empty" = "Cart must contain at least 1 item") — bind to it. Only create a new state when none fits. Two preconditions with the same meaning must end up on the same state.
   - **New state:** a short title for the situation ("Shipping information submitted"), the kind, and the minimal flow of recorded actions that produces it. Rely on recursion: you don't list what the flow's first action itself needs — its own preconditions are bound to states too, and the planner chains them (an expanded submenu's flow is just "Expand submenu"; its "side menu must be open" precondition points to the "Side menu open" state). Use `requires` only for something the flow needs that no precondition says.
   - **Watch for irreversible actions.** If the only flow is destructive (placing an order, deleting data, sending a message), still create it if it's genuinely the way, and say so in your report.
   - **Don't stretch, ask.** If no recorded action produces the state, or you can't tell whether a fresh session is already like that, or it needs particular data or an account: create the state **without a flow** (so the precondition is linked and visible), and add a **question** with concrete suggestions — e.g. *"Is 'the product must not already be in the cart' already true in a fresh session?"* suggesting `{"kind":"initial"}`; *"Which account has an existing order?"* suggesting `{"kind":"user","userId":"..."}` if such a user exists; a flow you aren't sure about as `{"kind":"flow",...}`. An honest question beats a test that passes while testing the wrong thing.
   - A state with status `needs_answer` and an open question is waiting for the human — leave it, unless a recorded action now clearly produces it (then you may give it a flow; the script refuses changes to anything the user owns).
   - **Copy preconditions verbatim** from `pending` — that's how a binding detects that `/navmap` later reworded it.
3. Write the staged file with the Write tool at `projects/<projectId>/.staging/states-<runId>.json` (get a run id with `npm run navmap:run-id`):
   ```json
   {
     "states": [
       { "id": "shipping-info-submitted", "title": "Shipping information submitted", "kind": "persistent",
         "flow": [{ "edgeId": "<action id>" }] },
       { "id": "product-not-in-cart", "title": "The product isn't in the cart yet", "kind": "persistent" }
     ],
     "bindings": [
       { "edgeId": "<action id>", "precondition": "<verbatim>", "stateId": "shipping-info-submitted" },
       { "edgeId": "<action id>", "precondition": "<verbatim>", "stateId": "cart-has-items", "sameItem": true }
     ],
     "questions": [
       { "about": { "kind": "state", "stateId": "product-not-in-cart", "issue": "no_flow" },
         "title": "Is \"The product isn't in the cart yet\" already true in a fresh session?",
         "detail": "Needed by Add item to cart from product detail. No recorded action empties the cart.",
         "suggestions": [{ "label": "Yes — already true at the start", "answer": { "kind": "initial" } }] }
     ]
   }
   ```
   - State ids: lowercase slugs, unique. Flow steps use the same fields as test-case steps (`edgeId`, optional `item`, `input`, `form`, `on` for a shared component action run on another page).
   - Questions about a state need that state to exist (new ones in the same file are fine). For things that aren't a state ("I need an account with an existing order"), use `"about": { "kind": "free" }` — but put suggestions only on state questions.
4. Run `npm run navmap:save-states -- <projectId> projects/<projectId>/.staging/states-<runId>.json`.
   - **Nothing saved** → fix the listed problems and re-run. It refuses changes the user owns: moving an existing binding, changing a state that has a flow or that the user answered/edited, marking anything initial/account/not automatable.
   - **Linked but still blocked** → read each blocker and fix the state or its flow (a transient flow that navigates, an action not available on the page that needs it, a user who can't reach a page), or turn it into a question. Then re-run.
5. **Only if `verify=true`:**
   1. Run `npm run navmap:generate-tests -- <projectId>`.
   2. Run only the newly runnable tests with `npx playwright test projects/<projectId>/tests/ -g "<title1>|<title2>" --reporter=line`. Specs are generated only from **approved** test cases — an action whose case is still a draft has no test to run; say so. Never create or approve cases yourself.
   3. For a failure, decide whether the **flow** is at fault (it ran but didn't produce the state) or something unrelated is. A wrong flow you created: fix it and re-save. Anything else: report it — don't change states the user owns.
6. **Report** in a few lines: states reused vs created, preconditions linked, questions asked (and why), the runnable-actions count before → after from `save-states`, and anything destructive in a flow.
