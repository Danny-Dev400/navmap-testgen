import type { Page, Locator as PwLocator } from "playwright";
import type { Locator, Postcondition } from "./navmap-types.js";

function jsStringLiteral(value: string): string {
  return JSON.stringify(value);
}

/** Direct 1:1 mapping — LocatorSchema's strategies were deliberately chosen to mirror
 *  Playwright's own locator API, so no guessing is needed here. */
export function locatorExpr(locator: Locator): string {
  switch (locator.strategy) {
    case "role": {
      const opts: string[] = [];
      if (locator.name) opts.push(`name: ${jsStringLiteral(locator.name)}`);
      if (locator.exact) opts.push("exact: true");
      const optsStr = opts.length > 0 ? `, { ${opts.join(", ")} }` : "";
      return `page.getByRole(${jsStringLiteral(locator.role)}${optsStr})`;
    }
    case "text": {
      const optsStr = locator.exact ? ", { exact: true }" : "";
      return `page.getByText(${jsStringLiteral(locator.text)}${optsStr})`;
    }
    case "label":
      return `page.getByLabel(${jsStringLiteral(locator.label)})`;
    case "placeholder":
      return `page.getByPlaceholder(${jsStringLiteral(locator.placeholder)})`;
    case "testId":
      return `page.getByTestId(${jsStringLiteral(locator.testId)})`;
    case "css":
      return `page.locator(${jsStringLiteral(locator.css)})`;
  }
}

/** Runtime sibling of locatorExpr — builds a live Playwright Locator instead of a source-code
 *  string, for scripts (like navmap-auth-setup) that drive the browser directly rather than
 *  generating a .spec.ts file. Same 1:1 mapping, same cases. */
export function resolveLocator(page: Page, locator: Locator): PwLocator {
  switch (locator.strategy) {
    case "role":
      return page.getByRole(locator.role as Parameters<Page["getByRole"]>[0], {
        name: locator.name,
        exact: locator.exact,
      });
    case "text":
      return page.getByText(locator.text, { exact: locator.exact });
    case "label":
      return page.getByLabel(locator.label);
    case "placeholder":
      return page.getByPlaceholder(locator.placeholder);
    case "testId":
      return page.getByTestId(locator.testId);
    case "css":
      return page.locator(locator.css);
  }
}

function escapeRegexChars(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Builds a JS RegExp literal string that matches a full absolute URL: the given origin
 *  (escaped literally) followed by the normalized urlPattern (from src/navmap-ids.ts — e.g.
 *  "/cart.html" or "/orders/:id", dynamic segments turned into [^/]+), anchored at both ends
 *  (^...(?:[/?#]|$)) so "/cart.html" can't spuriously match "/cart.html-extra" or a substring of
 *  an unrelated page. `toHaveURL` matches against the full URL including scheme+host, so the
 *  origin must be part of the pattern — anchoring on the path alone would let the path text
 *  spuriously match earlier in the string (e.g. inside "https://" itself for a root "/" pattern).
 *  Every literal "/" — from the origin's own "https://" and from the path separators — is
 *  escaped as "\/" as a final pass, since an unescaped "/" inside a `/.../ ` literal ends it
 *  early at the JS-syntax level (not just a regex-semantics concern). */
export function urlMatchRegexLiteral(origin: string, urlPattern: string): string {
  const pathSource = urlPattern
    .split("/")
    .map((segment) => (segment === ":id" ? "[^/]+" : escapeRegexChars(segment)))
    .join("/");
  const source = `^${escapeRegexChars(origin)}${pathSource}(?:[/?#]|$)`;
  return `/${source.replace(/\//g, "\\/")}/`;
}

/** Rebinds a locatorExpr() string (always "page.…") to another page reference, e.g. "this.page". */
export function withPageRef(expr: string, pageRef: string): string {
  return expr.startsWith("page.") ? `${pageRef}${expr.slice(4)}` : expr;
}

/** container.filter({ hasText }).<inner> — the one way to address an element that repeats per item
 *  (e.g. "Add to cart" on every product card). `hasTextExpr` is a source expression (a string
 *  literal or a parameter name), so POM methods can take the item as an argument. */
export function scopedLocatorExpr(scope: { container: Locator }, inner: Locator, hasTextExpr: string, pageRef = "page"): string {
  const container = withPageRef(locatorExpr(scope.container), pageRef);
  const innerChain = locatorExpr(inner).slice("page".length); // ".getByRole(...)"
  return `${container}.filter({ hasText: ${hasTextExpr} })${innerChain}`;
}

/** Regex literal matching any URL on an origin — for off-origin (external) destinations. */
export function originMatchRegexLiteral(url: string): string | undefined {
  try {
    return urlMatchRegexLiteral(new URL(url).origin, "");
  } catch {
    return undefined;
  }
}

// Old, free-text-only postconditions that describe something going away. Asserting the clicked
// element "is visible" for these is exactly backwards (caught live: "Remove item from cart"
// asserted the Remove button was still visible), so they become an honest TODO instead.
const DISAPPEARANCE_RE = /\b(no longer|disappear(s|ed)?|removed|hidden|gone|dismiss(es|ed)?|clos(es|ed)|not (be )?(visible|shown|listed|displayed))\b/i;
// ...or the clicked element itself changing (caught live: "Button now reads Remove" asserted the
// "Add to cart" locator was visible — but that button no longer exists under that name).
const CHANGE_RE = /\b(now (reads|says|shows|displays)|changes? to|becomes|turns into|replaced by|switch(es)? to)\b/i;

/** Returns a statement string (including trailing semicolon) that performs the assertion, or a
 *  commented-out TODO when it can't be derived from what the map actually recorded — a free-text
 *  description is prose for a human, never a literal value/URL/substring.
 *
 *  Preferred path — `post.check` (structured, recorded by /navmap): asserts against the
 *  postcondition's OWN locator, so it works on the destination page of a navigating edge too, and
 *  covers disappearance (`hidden`). `has_text`/`count` only use a value copied verbatim from
 *  the page.
 *
 *  Legacy path (maps recorded before checks existed):
 *  - url_matches: the caller-built regex from the destination page's urlPattern.
 *  - element_visible / text_visible: a visibility check on the clicked element — only when the edge
 *    stays on the same page (targetStillPresent) and the description doesn't say it goes away.
 *  - value_equals / status_ok: TODO — the exact expected value was never recorded structurally.
 *
 *  targetExpr is the already-resolved source expression for the clicked element (a POM field
 *  access like `loginPage.usernameInput`); check locators resolve against the test's `page`. */
export function assertionExpr(
  targetExpr: string,
  post: Postcondition,
  targetStillPresent: boolean,
  expectedUrlMatchRegexLiteral?: string,
): string {
  const todo = (why: string) => `// TODO: assert ${JSON.stringify(post.description)} (${why})`;
  const note = ` // ${post.description}`;

  if (post.check) {
    const c = post.check;
    if (c.kind === "url") {
      return expectedUrlMatchRegexLiteral ? `await expect(page).toHaveURL(${expectedUrlMatchRegexLiteral});${note}` : todo("url — no destination urlPattern recorded");
    }
    // Without its own locator a check can only fall back to the clicked element, and only if it's
    // still on screen.
    const target = c.locator ? locatorExpr(c.locator) : targetStillPresent ? targetExpr : undefined;
    if (!target) return todo(`${c.kind} — no locator recorded for the element this outcome is about`);
    switch (c.kind) {
      case "visible":
        return `await expect(${target}).toBeVisible();${note}`;
      case "hidden":
        return `await expect(${target}).toBeHidden();${note}`;
      case "has_text":
        return typeof c.value === "string"
          ? `await expect(${target}).toHaveText(${JSON.stringify(c.value)});${note}`
          : todo("has_text — no literal text was recorded");
      case "count":
        return typeof c.value === "number" ? `await expect(${target}).toHaveCount(${c.value});${note}` : todo("count — no literal count was recorded");
    }
  }

  switch (post.assertionType) {
    case "url_matches":
      return expectedUrlMatchRegexLiteral ? `await expect(page).toHaveURL(${expectedUrlMatchRegexLiteral});${note}` : todo("url_matches — no destination urlPattern recorded");
    case "element_visible":
    case "text_visible":
      if (!targetStillPresent) {
        return todo("this edge navigates to a different page and no locator was recorded for the destination element — re-explore to capture a check");
      }
      if (DISAPPEARANCE_RE.test(post.description)) {
        return todo("describes something disappearing, but only the clicked element's locator was recorded — re-explore to capture a 'hidden' check");
      }
      if (CHANGE_RE.test(post.description)) {
        return todo("describes the clicked element changing, so its recorded locator no longer matches — re-explore to capture a check on the new state");
      }
      return `await expect(${targetExpr}).toBeVisible();${note}`;
    case "value_equals":
      return todo("value_equals — exact expected value wasn't recorded, only this free-text description");
    case "status_ok":
      return todo("status_ok needs response interception — not auto-generated");
  }
}
