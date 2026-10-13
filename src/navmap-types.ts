import { z } from "zod/v4";
import { AssertionTypeSchema } from "./types.js";

export const LocatorSchema = z.discriminatedUnion("strategy", [
  z.object({ strategy: z.literal("role"), role: z.string(), name: z.string().optional(), exact: z.boolean().optional() }),
  z.object({ strategy: z.literal("text"), text: z.string(), exact: z.boolean().optional() }),
  z.object({ strategy: z.literal("label"), label: z.string() }),
  z.object({ strategy: z.literal("placeholder"), placeholder: z.string() }),
  z.object({ strategy: z.literal("testId"), testId: z.string() }),
  z.object({ strategy: z.literal("css"), css: z.string() }),
]);
export type Locator = z.infer<typeof LocatorSchema>;

export const RepairNoteSchema = z.object({ at: z.string(), runId: z.string(), reason: z.string().max(500) });
export type RepairNote = z.infer<typeof RepairNoteSchema>;

// An element worth reading or checking that isn't an action — a product's price, an order total,
// a status label. A fact about the page, so it lives in the map (test cases reference it by id and
// never carry locators). `scope` addresses one per list item, like ActionEdge.scope.
export const PageElementSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]{1,60}$/),
  label: z.string().min(1).max(120),
  locator: LocatorSchema,
  scope: z.object({ container: LocatorSchema, hasText: z.string().min(1) }).optional(),
  valueKind: z.enum(["text", "number", "currency"]),
  // "browser" = confirmed on the live page to match exactly one element; "snapshot" = derived from a
  // saved accessibility snapshot only (unverified until a test runs).
  source: z.enum(["snapshot", "browser"]),
  // Page text seen when recorded (never a credential).
  sample: z.string().max(200).optional(),
});
export type PageElement = z.infer<typeof PageElementSchema>;

export const PageNodeSchema = z.object({
  id: z.string(),
  urlPattern: z.string(),
  title: z.string(),
  requiresAuth: z.boolean().optional(),
  sampleUrls: z.array(z.string()).max(5),
  notes: z.string().optional(),
  group: z.string().optional(),
  // A unique landmark that proves you're on this page (usually its main heading) — lets generated
  // tests assert they actually arrived, so a redirect (e.g. to login) fails with a clear message.
  anchor: LocatorSchema.optional(),
  elements: z.array(PageElementSchema).optional(),
  lastRepair: RepairNoteSchema.optional(),
  firstSeenAt: z.string(),
  lastVerifiedAt: z.string(),
  timesObserved: z.number().int().min(1),
  sourceRunIds: z.array(z.string()),
});
export type PageNode = z.infer<typeof PageNodeSchema>;

export const IntentCategorySchema = z.enum([
  "navigation",
  "auth",
  "search_filter",
  "create",
  "read",
  "update",
  "delete",
  "form_submit",
  "state_toggle",
  "external",
  "other",
]);
export type IntentCategory = z.infer<typeof IntentCategorySchema>;

// The structured, machine-checkable form of a postcondition: what to assert, against which element
// (its OWN locator — not the clicked one), and a literal value only when it was copied verbatim
// from the page. Free-text descriptions are never turned into literals (see codegen pitfalls).
export const PostconditionCheckSchema = z.object({
  kind: z.enum(["visible", "hidden", "has_text", "url", "count"]),
  locator: LocatorSchema.optional(),
  value: z.union([z.string(), z.number()]).optional(),
});
export type PostconditionCheck = z.infer<typeof PostconditionCheckSchema>;

export const PostconditionSchema = z.object({
  description: z.string(),
  assertionType: AssertionTypeSchema,
  check: PostconditionCheckSchema.optional(),
});
export type Postcondition = z.infer<typeof PostconditionSchema>;

export const ActionEdgeSchema = z.object({
  id: z.string(),
  fromPageId: z.string(),
  toPageId: z.string(),
  semanticIntent: z.string(),
  intentCategory: IntentCategorySchema,
  action: z.string(),
  target: z.string(),
  inputValue: z.string().optional(),
  locator: LocatorSchema,
  // Set when the acted-on element is one of several identical ones (e.g. "Add to cart" on every
  // product card): the repeated container plus the text that singles out the recorded item.
  // Generated code becomes container.filter({ hasText }).<locator>.
  scope: z.object({ container: LocatorSchema, hasText: z.string().min(1) }).optional(),
  // Off-origin destination (e.g. an "About" link to the company site). Never a map page: toPageId
  // stays the origin page, and tests assert the external URL instead.
  external: z.object({ url: z.string(), opensNewTab: z.boolean() }).optional(),
  // Fields filled right before this action (e.g. a form's inputs before its submit click), with the
  // non-secret test values used. Generated methods fill them first, with these as defaults. Never
  // credentials — the login form keeps using authFormLocators + the credentials file.
  formFields: z
    .array(z.object({ label: z.string().min(1), locator: LocatorSchema, value: z.string(), action: z.enum(["fill", "select", "check"]).optional() }))
    .optional(),
  uiRegion: z.string().optional(),
  // Real, hard-to-undo side effects (placing an order, paying, deleting data, sending a message).
  // Tagged by /navmap; the user can override it per project (projects/<id>/edge-flags.json).
  // Generated tests touching it are tagged @destructive and excluded from default runs.
  destructive: z.boolean().optional(),
  // Set only on the one real login edge — the field locators the skill used to fill the
  // username/password inputs, captured separately from `locator` (which points at the submit
  // control). Never the credential values themselves, just where to put them.
  authFormLocators: z.object({ username: LocatorSchema, password: LocatorSchema }).optional(),
  preconditions: z.array(z.string()),
  requiresAuth: z.boolean().optional(),
  postconditions: z.array(PostconditionSchema),
  lastOutcome: z.enum(["success", "failed", "partial"]).optional(),
  screenshot: z.string().optional(),
  // Captured just before the action, with the target element highlighted.
  screenshotBefore: z.string().optional(),
  // Set when a triage fix the user approved changed this fact (e.g. a locator), so the map shows
  // it was repaired after a failing test rather than observed by exploration.
  lastRepair: RepairNoteSchema.optional(),
  firstSeenAt: z.string(),
  lastVerifiedAt: z.string(),
  timesObserved: z.number().int().min(1),
  sourceRunIds: z.array(z.string()),
});
export type ActionEdge = z.infer<typeof ActionEdgeSchema>;

export const NavigationMapSchema = z.object({
  id: z.string(),
  targetHost: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  totalRunsMerged: z.number().int().min(0),
  entryPageId: z.string().optional(),
  // Path to the credentials file this project's authenticated pages use (e.g.
  // "credentials/saucedemo.json") — never the credential values themselves. One per project;
  // multi-user/multi-section credentials are deliberately out of scope for now.
  credentialsRef: z.string().optional(),
  runHistory: z.array(
    z.object({
      runId: z.string(),
      mergedAt: z.string(),
      pagesTouched: z.number().int(),
      edgesTouched: z.number().int(),
    }),
  ),
  pages: z.record(z.string(), PageNodeSchema),
  edges: z.record(z.string(), ActionEdgeSchema),
});
export type NavigationMap = z.infer<typeof NavigationMapSchema>;

export interface ProjectSummary {
  id: string;
  targetHost: string;
  pageCount: number;
  edgeCount: number;
  totalRunsMerged: number;
  updatedAt: string;
  /** Dashboard card health — computed by the dev server, absent in static reports. */
  health?: {
    /** Approved test cases that generate as runnable tests, of all approved ones. */
    runnable: number;
    total: number;
    /** Cases awaiting review. */
    drafts: number;
    lastRun: { finishedAt: string; passed: number; failed: number; flaky: number; skipped: number } | null;
    /** Cumulative estimated agent cost (plan quota on a subscription). */
    quotaUsd: number;
  };
}

export const NavMapRunBatchSchema = z.object({
  runId: z.string(),
  targetUrl: z.string(),
  startedAt: z.string(),
  finishedAt: z.string(),
  summary: z.string(),
  entryPageId: z.string().optional(),
  credentialsRef: z.string().optional(),
  pages: z.array(PageNodeSchema),
  edges: z.array(ActionEdgeSchema),
});
export type NavMapRunBatch = z.infer<typeof NavMapRunBatchSchema>;
