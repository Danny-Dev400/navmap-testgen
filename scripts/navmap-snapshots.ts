import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser, type BrowserContext } from "playwright";
import { NavigationMapSchema } from "../src/navmap-types.js";
import { chooseUserForPage, loadProjectUsers, storageStatePathFor } from "../src/navmap-users.js";
import { resolveLocator, urlMatchRegexLiteral } from "../src/navmap-playwright-gen.js";
import { snapshotPathFor, scrubSnapshots } from "../src/navmap-snapshots.js";
import { projectSecrets, scrub } from "../src/navmap-secrets.js";
import { performLogin, readCredentials } from "../src/navmap-auth.js";
import { resolveMapArg } from "../src/project-paths.js";

// Captures each page's accessibility snapshot by visiting its recorded URL — no agent, no quota,
// no clicks or typing (only page loads). A page is only captured when the browser really arrives
// on it (URL + recorded landmark), so a redirect or a page that needs prior state (e.g. a filled
// cart) is skipped rather than saved under the wrong name; exploration captures those.
const args = process.argv.slice(2);
const mapArg = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--page");
const pageFlag = args.indexOf("--page");
const onlyPage = pageFlag >= 0 ? args[pageFlag + 1] : undefined;
if (!mapArg || (pageFlag >= 0 && !onlyPage)) {
  console.error("Usage: npm run navmap:snapshots -- <project-id | path-to-navmap.json> [--page <pageId>]");
  process.exit(1);
}

const rootDir = process.cwd();
const map = NavigationMapSchema.parse(JSON.parse(await readFile(resolveMapArg(mapArg), "utf-8")));
const users = await loadProjectUsers(rootDir, map);
const pages = Object.values(map.pages).filter((p) => !onlyPage || p.id === onlyPage);
if (onlyPage && pages.length === 0) {
  console.error(`No page "${onlyPage}" in project "${map.id}".`);
  process.exit(1);
}

const exists = (p: string) => access(p).then(() => true, () => false);
const results: { pageId: string; title: string; captured: boolean; reason?: string }[] = [];
let browser: Browser | undefined;
const contexts = new Map<string, BrowserContext>();
const renewed = new Set<string>(); // users whose session was renewed this run (at most once each)
const secrets = await projectSecrets(rootDir, map);

/** A saved session with no cookie past its expiry (same signal the generated fixtures use). */
async function sessionLooksFresh(file: string): Promise<boolean> {
  if (!(await exists(file))) return false;
  try {
    const state = JSON.parse(await readFile(file, "utf-8"));
    const now = Date.now() / 1000;
    return !(state.cookies ?? []).some((c: { expires?: number }) => typeof c.expires === "number" && c.expires > 0 && c.expires < now);
  } catch {
    return false;
  }
}

/** Visits the page and saves its snapshot only if the browser really arrived on it. */
async function capture(page: (typeof map.pages)[string], url: string, context: BrowserContext | string): Promise<"captured" | "not-arrived" | string> {
  if (typeof context === "string") return context;
  const tab = await context.newPage();
  try {
    await tab.goto(url, { waitUntil: "load", timeout: 30_000 });
    const literal = urlMatchRegexLiteral(new URL(url).origin, page.urlPattern);
    if (!new RegExp(literal.slice(1, -1)).test(tab.url())) return "not-arrived";
    if (page.anchor) {
      const landmark = await resolveLocator(tab, page.anchor)
        .first()
        .waitFor({ state: "visible", timeout: 5_000 })
        .then(() => true, () => false);
      if (!landmark) return "not-arrived";
    }
    const file = path.join(rootDir, snapshotPathFor(map.id, page.id));
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, await tab.locator("body").ariaSnapshot(), "utf-8");
    return "captured";
  } catch (err) {
    return `couldn't load it: ${(err as Error).message.split("\n")[0]}`;
  } finally {
    await tab.close();
  }
}

try {
  browser = await chromium.launch({ headless: true });
  for (const page of pages) {
    const skip = (reason: string) => results.push({ pageId: page.id, title: page.title, captured: false, reason });
    const url = page.sampleUrls[0];
    if (!url) {
      skip("no recorded URL");
      continue;
    }
    const user = chooseUserForPage(page, users);
    if (!user) {
      skip("no configured user can access it");
      continue;
    }
    const contextFor = async (renew: boolean): Promise<BrowserContext | string> => {
      const cached = contexts.get(user.id);
      if (cached && !renew) return cached;
      await cached?.close();
      contexts.delete(user.id);
      if (user.kind !== "auth") {
        const ctx = await browser!.newContext();
        contexts.set(user.id, ctx);
        return ctx;
      }
      const state = path.join(rootDir, storageStatePathFor(map, user.id));
      // Same rule as the generated fixtures: a missing or expired session is renewed by logging in
      // through the recorded login form (only when this user has credentials).
      if (renew || !(await sessionLooksFresh(state))) {
        if (renewed.has(user.id)) return `${user.label}'s session couldn't be renewed`;
        renewed.add(user.id);
        if (!user.credentialsRef) return `${user.label} has no saved session and no credentials — set them up in the Users tab`;
        try {
          await performLogin(map, await readCredentials(rootDir, user.credentialsRef), state);
        } catch (err) {
          return `${user.label}'s login failed (${scrub((err as Error).message.split("\n")[0], secrets)})`;
        }
      }
      const ctx = await browser!.newContext({ storageState: state });
      contexts.set(user.id, ctx);
      return ctx;
    };

    // One retry with a renewed session for auth users: a session can look fresh and still be dead.
    let outcome = await capture(page, url, await contextFor(false));
    if (outcome === "not-arrived" && user.kind === "auth" && !renewed.has(user.id)) outcome = await capture(page, url, await contextFor(true));
    if (outcome === "captured") results.push({ pageId: page.id, title: page.title, captured: true });
    else if (outcome === "not-arrived") skip("didn't arrive on it from its URL — it needs prior state (e.g. a filled cart); captured on the next exploration");
    else skip(outcome);
  }
} finally {
  await browser?.close();
}

const scrubbed = await scrubSnapshots(rootDir, map.id, secrets);

for (const r of results) console.log(`${r.captured ? "✓" : "–"} ${r.title}${r.reason ? ` — ${r.reason}` : ""}`);
const captured = results.filter((r) => r.captured).length;
console.log(`Captured ${captured} of ${results.length} page snapshot(s) into projects/${map.id}/snapshots/${scrubbed ? ` (scrubbed credentials from ${scrubbed})` : ""}.`);
// Machine-readable last line for the dashboard.
console.log(`SNAPSHOTS_JSON ${JSON.stringify({ captured, total: results.length, results })}`);
