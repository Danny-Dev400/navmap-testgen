import type { NavigationMap } from "./navmap-types.js";
import { storageStatePathFor, userCanAccess, type ProjectUser } from "./navmap-users.js";
import { instanceVarName, toPascalCase } from "./navmap-pom-generator.js";
import { locatorExpr, urlMatchRegexLiteral } from "./navmap-playwright-gen.js";
import { SESSION_HELPERS_SOURCE, VALUE_HELPERS_SOURCE } from "./navmap-fixtures-session.js";

function jsStringLiteral(value: string): string {
  return JSON.stringify(value);
}

export interface UserFixture {
  user: ProjectUser;
  /** Playwright fixture name, e.g. "generalUser" — what a test destructures. */
  fixtureName: string;
  /** Per-user page wrapper class, e.g. "GeneralUserPages". */
  wrapperClassName: string;
  /** pageId -> getter name on the wrapper, only for pages this user may access. */
  pageGetters: Map<string, string>;
}

/** Names derive from the user id (not the label) because ids are unique by construction —
 *  two users both labelled "Admin" must still get two distinct fixtures. */
export function planUserFixtures(
  users: ProjectUser[],
  map: NavigationMap,
  pageClassNames: Map<string, string>,
): UserFixture[] {
  return users.map((user) => {
    const base = toPascalCase(user.id, "Anonymous");
    const stem = base.endsWith("User") ? base : `${base}User`;
    const pageGetters = new Map<string, string>();
    for (const [pageId, className] of pageClassNames) {
      const page = map.pages[pageId];
      if (page && userCanAccess(user, page)) pageGetters.set(pageId, instanceVarName(className));
    }
    // instanceVarName just lower-cases the first letter of the already-PascalCased stem — toCamelCase
    // would re-split on non-alphanumerics, see "GuestUser" as one word, and flatten it to "guestuser".
    return { user, fixtureName: instanceVarName(stem), wrapperClassName: `${stem}Pages`, pageGetters };
  });
}

/** The page wrapper: one lazily-constructed getter per page the user may access, and nothing
 *  else — so using a page outside a user's allow-list is a compile error in the test, not a
 *  runtime surprise. */
export function buildUserPagesClass(fixture: UserFixture, pageClassNames: Map<string, string>): string {
  const entries = [...fixture.pageGetters].map(([pageId, getter]) => ({ getter, className: pageClassNames.get(pageId)! }));
  const imports = entries.map((e) => `import { ${e.className} } from "../pages/${e.className}";`).join("\n");
  const fields = entries.map((e) => `  private _${e.getter}?: ${e.className};`).join("\n");
  const getters = entries
    .map(
      (e) => `  get ${e.getter}(): ${e.className} {
    return (this._${e.getter} ??= new ${e.className}(this.page));
  }`,
    )
    .join("\n\n");
  const access = fixture.user.allowedPageIds ? "restricted allow-list" : `every page a${fixture.user.kind === "guest" ? " guest" : "n authenticated user"} can reach`;

  return `// Generated page wrapper for user "${fixture.user.label}" (${fixture.user.kind}, ${access}) — do not hand-edit, regenerate instead.
import type { Page } from "@playwright/test";
${imports}

export class ${fixture.wrapperClassName} {
  readonly page: Page;
${fields ? `\n${fields}\n` : ""}
  constructor(page: Page) {
    this.page = page;
  }
${getters ? `\n${getters}\n` : ""}}
`;
}

/** The map's recorded login form as a function, so fixtures can renew an expired session on their
 *  own. Mirrors performLogin (src/navmap-auth.ts) but is emitted into the generated code, keeping
 *  generated tests standalone. Without a recorded login form, re-login is impossible and the
 *  fixture skips with guidance instead. */
function buildLoginFunction(map: NavigationMap): string {
  const loginEdge = Object.values(map.edges).find((e) => e.intentCategory === "auth" && e.authFormLocators);
  const loginPage = loginEdge ? map.pages[loginEdge.fromPageId] : undefined;
  const loginUrl = loginPage?.sampleUrls[0];
  if (!loginEdge?.authFormLocators || !loginUrl) {
    return `const canLogIn = false;
async function login(_page: Page, _creds: Credentials): Promise<void> {
  throw new Error("No login form was recorded in this project's map.");
}`;
  }
  const dest = map.pages[loginEdge.toPageId];
  const arrival = dest && loginEdge.toPageId !== loginEdge.fromPageId ? `\n  await expect(page).toHaveURL(${urlMatchRegexLiteral(new URL(loginUrl).origin, dest.urlPattern)});` : "";
  return `const canLogIn = true;
/** The recorded login form (${loginPage!.title}). creds.loginUrl, when set, overrides the recorded page. */
async function login(page: Page, creds: Credentials): Promise<void> {
  await page.goto(creds.loginUrl ?? ${jsStringLiteral(loginUrl)});
  await ${locatorExpr(loginEdge.authFormLocators.username)}.fill(creds.username);
  await ${locatorExpr(loginEdge.authFormLocators.password)}.fill(creds.password);
  await ${locatorExpr(loginEdge.locator)}.click();${arrival}
}`;
}

/** fixtures.ts: one Playwright fixture per user, each in its own browser context (auth users
 *  restored from their storageState), yielding that user's page wrapper. Credential values are
 *  never written here — only file paths; loadCredentials reads them when a test runs. */
export function buildFixturesFile(fixtures: UserFixture[], map: NavigationMap): string {
  const imports = fixtures.map((f) => `import { ${f.wrapperClassName} } from "./users/${f.wrapperClassName}";`).join("\n");
  const credentialRefs = fixtures
    .filter((f) => f.user.kind === "auth" && f.user.credentialsRef)
    .map((f) => `  ${jsStringLiteral(f.user.id)}: ${jsStringLiteral(f.user.credentialsRef!)},`)
    .join("\n");
  const types = fixtures.map((f) => `  ${f.fixtureName}: ${f.wrapperClassName};`).join("\n");

  const definitions = fixtures
    .map((f) => {
      if (f.user.kind === "guest") {
        return `  ${f.fixtureName}: async ({ browser, viewport, video }, use, testInfo) => {
    const { page, close } = await openUserContext(browser, testInfo, viewport, video);
    await use(new ${f.wrapperClassName}(page));
    await close();
  },`;
      }
      const statePath = storageStatePathFor(map, f.user.id);
      return `  ${f.fixtureName}: async ({ browser, viewport, video }, use, testInfo) => {
    const storageState = ${jsStringLiteral(statePath)};
    await ensureSession(browser, testInfo, ${jsStringLiteral(f.user.id)}, ${jsStringLiteral(f.user.label)}, storageState);
    const { page, close } = await openUserContext(browser, testInfo, viewport, video, storageState);
    await use(new ${f.wrapperClassName}(page));
    await close();
  },`;
    })
    .join("\n");

  const hasAuthUsers = fixtures.some((f) => f.user.kind === "auth");
  const sessionBlock = hasAuthUsers ? `\n${buildLoginFunction(map)}\n\n${SESSION_HELPERS_SOURCE}\n` : "";

  return `// Generated user fixtures for ${map.targetHost} — do not hand-edit, regenerate instead.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { test as base, expect, type Browser, type Locator, type Page, type PlaywrightWorkerOptions, type TestInfo, type ViewportSize } from "@playwright/test";
${imports}

const credentialsRefs: Record<string, string> = {
${credentialRefs}
};

type Credentials = { username: string; password: string; loginUrl?: string };

/** Reads a user's credentials when the test runs — the values are never written into generated code. */
export function loadCredentials(userId: string): Credentials {
  const ref = credentialsRefs[userId];
  if (!ref) throw new Error(\`User "\${userId}" has no credentials file — set a password in the Users tab.\`);
  return JSON.parse(readFileSync(ref, "utf-8"));
}

function loadCredentialsIfPresent(userId: string): Credentials | undefined {
  const ref = credentialsRefs[userId];
  return ref && existsSync(ref) ? loadCredentials(userId) : undefined;
}

${VALUE_HELPERS_SOURCE}
${sessionBlock}
/** Each user gets its own context, so Playwright's built-in context/page fixtures (and the
 *  viewport/video they'd apply) aren't used — this applies the project's viewport and video
 *  settings (navmaps/settings/, via playwright.config.ts) by hand. Timeouts, traces and failure
 *  screenshots already reach manually created contexts through the test runner. */
async function openUserContext(
  browser: Browser,
  testInfo: TestInfo,
  viewport: ViewportSize | null,
  video: PlaywrightWorkerOptions["video"],
  storageState?: string,
) {
  const mode = typeof video === "string" ? video : video.mode;
  const record = mode === "on" || mode === "retain-on-failure" || (mode === "on-first-retry" && testInfo.retry === 1);
  const context = await browser.newContext({
    viewport,
    ...(storageState ? { storageState } : {}),
    ...(record ? { recordVideo: { dir: testInfo.outputPath("videos"), ...(viewport ? { size: viewport } : {}) } } : {}),
  });
  const page = await context.newPage();
  const close = async () => {
    const recording = page.video();
    await context.close();
    if (!recording) return;
    const videoPath = await recording.path();
    // attach() copies the file into the report, so the raw recording is removed either way.
    if (mode !== "retain-on-failure" || testInfo.status !== testInfo.expectedStatus) {
      await testInfo.attach("video", { path: videoPath, contentType: "video/webm" });
    }
    rmSync(videoPath, { force: true });
  };
  return { page, close };
}

type UserFixtures = {
${types}
};

export const test = base.extend<UserFixtures>({
${definitions}
});

export { expect };
`;
}
