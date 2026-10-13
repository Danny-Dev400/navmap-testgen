import { useEffect, useRef, useState } from "react";
import { cx, usePopoverFit } from "./ui/kit";

/** Short explanations of the tool's concepts, for someone who didn't build it. Shown by <HelpTip>. */
export const HELP = {
  home: {
    title: "Home",
    text: "Where the project stands (map → cases → runs → diagnosis), the one thing to do next, and an inbox of everything waiting for your decision.",
  },
  inbox: {
    title: "Inbox",
    text: "Things that need you: drafts to review, cases the map changed under, approved cases that can't run yet, failures nobody has looked at, proposed fixes and missing sessions. Each item has its own action.",
  },
  map: {
    title: "Navigation map",
    text: "What the app is: its pages and the actions that lead from one to another, with the locators that find each element. Built by the explorer agent; it never contains test cases.",
  },
  snapshots: {
    title: "Page snapshots",
    text: "A text copy of what each page shows (roles, names, visible text). Agents read it to find elements the map didn't record without opening a browser. 'Refresh' visits each page by URL — free, no agent.",
  },
  cases: {
    title: "Test cases",
    text: "What to test, as a list of steps that reuse map actions, the data they use and what to check after each step. Only approved cases become automated tests; the code is regenerated on its own.",
  },
  status: {
    title: "Draft / approved / rejected",
    text: "Draft: proposed, not a test yet. Approved: generated as a test and run. Rejected: dismissed — kept so it isn't proposed again.",
  },
  needsReview: {
    title: "Needs review",
    text: "The map changed under this case (an action, check or element it uses was removed or renamed). The case is never deleted — open it to see what changed.",
  },
  fixme: {
    title: "Fixme",
    text: "The case is approved but can't be generated as a runnable test yet — e.g. a precondition no recorded action sets up, or a data row whose expected value nobody has observed. The reason is shown on the case.",
  },
  setup: {
    title: "Setup (precondition links)",
    text: "Actions that run before the test to put the app in the right state (e.g. add a product before opening the cart). They come from precondition links, made by the linker agent in the Assistant.",
  },
  sharedItem: {
    title: "Use the same item",
    text: "When a setup action picks an item from a list (add a product) and the test acts on a list item too (remove a product), tick this so the setup uses the test's item instead of the one recorded.",
  },
  requires: {
    title: "Before this case, run another case",
    text: "Reuse a whole case as the start of this one — its steps run first, in the same browser. Most cases don't need it: tests already start logged in when the page requires it.",
  },
  dataTable: {
    title: "Data table",
    text: "Run the same case once per row. Write {{column}} in a step value (item, input, form field, expected value) and give each row its values. Each row becomes its own test.",
  },
  expected: {
    title: "Expected values",
    text: "What the page must show after a step. Copy it from what the page really shows — never guess. A data row whose expected value is empty stays fixme until someone fills it.",
  },
  values: {
    title: "Captured values and checks",
    text: "Read a value on one step (📌 e.g. a product's price) and compare it later (🟰 e.g. the total equals the sum of the prices). Elements like prices are recorded in the map.",
  },
  journeys: {
    title: "Journeys",
    text: "Complete paths through the app, start to finish (e.g. Login → Products → Cart → Checkout → Order complete), computed from the map. ✓ an approved case walks it end to end, ◐ only in pieces, ✗ parts are untested.",
  },
  destructive: {
    title: "Destructive",
    text: "Actions with real, hard-to-undo side effects (placing an order, deleting data). Tests that touch them are tagged 🧨 and skipped by default runs unless you include them.",
  },
  assistant: {
    title: "Assistant",
    text: "The AI agents, in one place: explore the site, design cases, link preconditions, diagnose failures. They use your plan's quota; they never approve or apply anything — you do.",
  },
  hint: {
    title: "Free hint",
    text: "A first read of why a test failed, from the error text alone (no AI): a slow site, an expired session, a missing element, a value mismatch… When it's the site or the network, a free rerun is the cheapest first step.",
  },
  triage: {
    title: "Diagnosis (triage)",
    text: "An agent reads the failure, the page at that moment and the map, and says whether it's an app bug, a test bug or the environment. For a test bug it proposes a fix — verified by re-running before you approve it.",
  },
  regeneration: {
    title: "Generated code",
    text: "Page objects and tests are rebuilt from the map and the approved cases after every change — never edit them by hand. 'View changes' shows what the last change did.",
  },
  features: {
    title: "Features → use cases",
    text: "Cases organized by what the app does. A feature is a capability (Shopping cart); a use case is a goal a user has there (Add a product to the cart); the cases under it prove that goal. The code stays organized by page — each test only gets a @feature-… tag.",
  },
  useCaseStatus: {
    title: "Use case status",
    text: "✓ approved cases ran and passed, and together they walk every action of the use case. ◐ it has approved cases, but some can't run yet (fixme), haven't run, aren't all green, or leave some of its actions untouched. ✗ one of its cases failed. ○ no approved case yet.",
  },
  requirements: {
    title: "Requirements",
    text: "Business requirements (user stories) split into acceptance criteria, each linked to the test cases that prove it — so you see what's covered and whether it passes (the traceability matrix). Paste or import them; the analyst agent (text only) proposes criteria and links for you to accept, and the designer builds cases for what's uncovered. Linked tests get a @req-… tag.",
  },
  criterionStatus: {
    title: "Criterion status",
    text: "From its linked cases and their last run: Passing (every approved, runnable case passed) · Failing (one failed) · Not run yet · Can't run yet (fixme) · Only draft cases (approve them) · No test case (link one, or design one).",
  },
  suites: {
    title: "Suites",
    text: "A named set of cases you pick by hand and run together (\"Smoke\", \"Checkout regression\"), across features and pages. Only its approved cases run. In the generated code each of its tests gets a @suite-… tag, so `npx playwright test --grep @suite-smoke` runs it outside the dashboard too.",
  },
  selection: {
    title: "Selecting cases",
    text: "Tick the box at the left of a case (it shows on hover), or a group's box to take all its cases. Shift-click selects a range. Then run, export, save as a suite, change status, move or delete them from the bar at the bottom.",
  },
  unsorted: {
    title: "Unsorted",
    text: "Cases that don't belong to a use case yet. The suggestion comes from the case's actions — it's only applied when you click Sort.",
  },
  organizer: {
    title: "Organizer",
    text: "An agent that reads the map, the journeys and your cases and proposes features → use cases, placing every case. Text only, no browser — cheap. You review the proposal before anything changes; run it again later and it only adds what's new.",
  },
  states: {
    title: "States & flows",
    text: "A state is a situation the app must be in before a test can do something — “Cart has items”, “Side menu open”. Its flow is the list of map actions that gets there, written once and reused by every test that needs it. Actions' preconditions point to states; a case can also ask for states with Given.",
  },
  stateKinds: {
    title: "Kinds of state",
    text: "Persists: survives navigation (cart contents, a submitted form) — its flow is a reusable function in flows.ts. On the page: exists only on the page that needs it (an open menu) — its steps run right there. Already true: a fresh session is already like that, nothing to do. User: the test runs as a specific user.",
  },
  given: {
    title: "Given",
    text: "The states a test is put in before its own steps, in order: the case's own Given states, then whatever its first step's preconditions point to (and what those flows need in turn). Each shows as a “Given — …” step in the code and the report.",
  },
  questions: {
    title: "Questions for you",
    text: "When nobody knows how a test can reach a state, the tool asks instead of guessing: answer once — with a flow, “already true at the start”, “same as another state”, a user, or “can't be automated” — and every test that needs it reuses the answer. Agents can also ask you things here; they never answer for you.",
  },
  notAutomatable: {
    title: "Can't be automated",
    text: "You said this state can't be reached by an automated test (it needs a human, an external system, real money…). Tests that need it stay fixme with your reason, and it's never asked again.",
  },
  featureTags: {
    title: "Feature tags",
    text: "Each test of a sorted case is tagged @feature-<id> (and annotated with its use case), so `npx playwright test --grep @feature-checkout` runs one feature and the HTML report can filter by it. Renaming a feature keeps its tag.",
  },
} as const;

export type HelpTopic = keyof typeof HELP;

/** A small "?" whose explanation shows on hover (or keyboard focus). A click pins it open — handy on
 *  touch screens — until a click outside or Escape. Leaving waits a moment, so the pointer can move
 *  onto the text. */
export function HelpTip({ topic }: { topic: HelpTopic }) {
  const [hovered, setHovered] = useState(false);
  const [pinned, setPinned] = useState(false);
  const open = hovered || pinned;
  const ref = useRef<HTMLSpanElement>(null);
  const popRef = useRef<HTMLSpanElement>(null);
  const leaveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const fit = usePopoverFit(open, popRef);
  const show = () => {
    clearTimeout(leaveTimer.current);
    setHovered(true);
  };
  const hide = () => {
    clearTimeout(leaveTimer.current);
    leaveTimer.current = setTimeout(() => setHovered(false), 150);
  };
  useEffect(() => () => clearTimeout(leaveTimer.current), []);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) {
        setPinned(false);
        setHovered(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      // preventDefault: Escape closes only this tip, not the panel or selection around it.
      if (e.key === "Escape") {
        e.preventDefault();
        setPinned(false);
        setHovered(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  const h = HELP[topic];
  return (
    <span className="help-tip" ref={ref} onMouseEnter={show} onMouseLeave={hide}>
      <button
        type="button"
        className="help-tip-button"
        aria-label={`What is "${h.title}"?`}
        aria-expanded={open}
        onFocus={show}
        onBlur={hide}
        onClick={(e) => {
          e.stopPropagation();
          setPinned((p) => !p);
        }}
      >
        ?
      </button>
      {open && (
        <span ref={popRef} className={cx("help-tip-popover", fit.up && "ui-pop-up", fit.flipX && "help-tip-flip-x")} role="tooltip">
          <strong>{h.title}</strong>
          <span>{h.text}</span>
        </span>
      )}
    </span>
  );
}
