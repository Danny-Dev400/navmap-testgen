import type { ActionEdge, NavigationMap, NavMapRunBatch, PageElement, PageNode, Postcondition } from "./navmap-types.js";

const RUN_HISTORY_CAP = 200;
const SAMPLE_URLS_CAP = 5;

function isEmpty(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === "string") return value.length === 0;
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

/** Latest-wins, unless the incoming value is empty/undefined — a sparser re-observation never erases prior detail. */
function pick<T>(existing: T, incoming: T): T {
  return isEmpty(incoming) ? existing : incoming;
}

function unionCapped(existing: string[], incoming: string[], cap: number): string[] {
  const merged = [...existing];
  for (const url of incoming) {
    if (!merged.includes(url)) merged.push(url);
  }
  return merged.length > cap ? merged.slice(merged.length - cap) : merged;
}

/** Latest list wins (like pick), but a re-observation that describes the same postcondition without
 *  a structured check keeps the check recorded earlier — sparser runs never erase detail. */
function mergePostconditions(existing: Postcondition[], incoming: Postcondition[]): Postcondition[] {
  if (isEmpty(incoming)) return existing;
  const checks = new Map(existing.filter((p) => p.check).map((p) => [p.description, p.check]));
  return incoming.map((p) => (p.check || !checks.has(p.description) ? p : { ...p, check: checks.get(p.description) }));
}

/** By element id: an incoming element replaces that id, every other recorded one is kept — a
 *  re-observation that didn't look at an element never erases it. */
export function mergeElements(existing: PageElement[] | undefined, incoming: PageElement[] | undefined): PageElement[] | undefined {
  if (isEmpty(incoming)) return existing;
  const byId = new Map((existing ?? []).map((e) => [e.id, e]));
  for (const e of incoming!) byId.set(e.id, e);
  return [...byId.values()];
}

function unionRunIds(existing: string[], incoming: string[]): string[] {
  return Array.from(new Set([...existing, ...incoming]));
}

function mergePageNode(existing: PageNode | undefined, incoming: PageNode): PageNode {
  if (!existing) return incoming;
  return {
    ...existing,
    urlPattern: pick(existing.urlPattern, incoming.urlPattern),
    title: pick(existing.title, incoming.title),
    requiresAuth: incoming.requiresAuth ?? existing.requiresAuth,
    sampleUrls: unionCapped(existing.sampleUrls, incoming.sampleUrls, SAMPLE_URLS_CAP),
    notes: pick(existing.notes, incoming.notes),
    group: pick(existing.group, incoming.group),
    anchor: incoming.anchor ?? existing.anchor,
    elements: mergeElements(existing.elements, incoming.elements),
    firstSeenAt: existing.firstSeenAt < incoming.firstSeenAt ? existing.firstSeenAt : incoming.firstSeenAt,
    lastVerifiedAt: incoming.lastVerifiedAt,
    timesObserved: existing.timesObserved + incoming.timesObserved,
    sourceRunIds: unionRunIds(existing.sourceRunIds, incoming.sourceRunIds),
  };
}

function mergeActionEdge(existing: ActionEdge | undefined, incoming: ActionEdge): ActionEdge {
  if (!existing) return incoming;
  return {
    ...existing,
    fromPageId: pick(existing.fromPageId, incoming.fromPageId),
    toPageId: pick(existing.toPageId, incoming.toPageId),
    semanticIntent: pick(existing.semanticIntent, incoming.semanticIntent),
    intentCategory: pick(existing.intentCategory, incoming.intentCategory),
    action: pick(existing.action, incoming.action),
    target: pick(existing.target, incoming.target),
    inputValue: pick(existing.inputValue, incoming.inputValue),
    locator: incoming.locator ?? existing.locator,
    scope: incoming.scope ?? existing.scope,
    external: incoming.external ?? existing.external,
    formFields: pick(existing.formFields, incoming.formFields),
    destructive: incoming.destructive ?? existing.destructive,
    uiRegion: pick(existing.uiRegion, incoming.uiRegion),
    authFormLocators: incoming.authFormLocators ?? existing.authFormLocators,
    preconditions: pick(existing.preconditions, incoming.preconditions),
    requiresAuth: incoming.requiresAuth ?? existing.requiresAuth,
    postconditions: mergePostconditions(existing.postconditions, incoming.postconditions),
    lastOutcome: incoming.lastOutcome ?? existing.lastOutcome,
    screenshot: pick(existing.screenshot, incoming.screenshot),
    screenshotBefore: pick(existing.screenshotBefore, incoming.screenshotBefore),
    firstSeenAt: existing.firstSeenAt < incoming.firstSeenAt ? existing.firstSeenAt : incoming.firstSeenAt,
    lastVerifiedAt: incoming.lastVerifiedAt,
    timesObserved: existing.timesObserved + incoming.timesObserved,
    sourceRunIds: unionRunIds(existing.sourceRunIds, incoming.sourceRunIds),
  };
}

export function mergeNavigationMap(
  existing: NavigationMap | null,
  batch: NavMapRunBatch,
  hostSlug: string,
  targetHost: string,
): NavigationMap {
  const base: NavigationMap = existing ?? {
    id: hostSlug,
    targetHost,
    createdAt: batch.startedAt,
    updatedAt: batch.startedAt,
    totalRunsMerged: 0,
    runHistory: [],
    pages: {},
    edges: {},
  };

  const pages = { ...base.pages };
  for (const incomingPage of batch.pages) {
    pages[incomingPage.id] = mergePageNode(pages[incomingPage.id], incomingPage);
  }

  const edges = { ...base.edges };
  for (const incomingEdge of batch.edges) {
    edges[incomingEdge.id] = mergeActionEdge(edges[incomingEdge.id], incomingEdge);
  }

  for (const edge of Object.values(edges)) {
    if (!pages[edge.fromPageId]) {
      throw new Error(`Edge "${edge.id}" references unknown fromPageId "${edge.fromPageId}" — not present in pages.`);
    }
    if (!pages[edge.toPageId]) {
      throw new Error(`Edge "${edge.id}" references unknown toPageId "${edge.toPageId}" — not present in pages.`);
    }
  }

  const runHistory = [
    ...base.runHistory,
    {
      runId: batch.runId,
      mergedAt: batch.finishedAt,
      pagesTouched: batch.pages.length,
      edgesTouched: batch.edges.length,
    },
  ].slice(-RUN_HISTORY_CAP);

  return {
    ...base,
    updatedAt: batch.finishedAt,
    totalRunsMerged: base.totalRunsMerged + 1,
    entryPageId: base.entryPageId ?? batch.entryPageId,
    credentialsRef: base.credentialsRef ?? batch.credentialsRef,
    runHistory,
    pages,
    edges,
  };
}
