import { readFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import { z } from "zod/v4";
import type { NavigationMap } from "./navmap-types.js";
import { resolveLocator } from "./navmap-playwright-gen.js";

export const CredentialsSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
  loginUrl: z.string().optional(),
});
export type Credentials = z.infer<typeof CredentialsSchema>;

export async function readCredentials(rootDir: string, credentialsRef: string): Promise<Credentials> {
  const raw = await readFile(path.resolve(rootDir, credentialsRef), "utf-8");
  return CredentialsSchema.parse(JSON.parse(raw));
}

/** Logs in through the map's recorded login edge and saves the resulting session as a Playwright
 *  storageState file. Throws (never prints credentials) on any missing prerequisite. */
export async function performLogin(map: NavigationMap, credentials: Credentials, outputPath: string): Promise<void> {
  // The logout edge is also intentCategory "auth" but has no authFormLocators — this is what
  // unambiguously picks out the real login edge among possibly several "auth" edges.
  const loginEdge = Object.values(map.edges).find((e) => e.intentCategory === "auth" && e.authFormLocators);
  if (!loginEdge?.authFormLocators) {
    throw new Error(
      `No login edge with authFormLocators in navmap "${map.id}" — re-run /navmap with creds=<path> to capture the username/password field locators.`,
    );
  }

  const gotoUrl = credentials.loginUrl ?? map.pages[loginEdge.fromPageId]?.sampleUrls[0];
  if (!gotoUrl) {
    throw new Error("No loginUrl in the credentials file and no sampleUrls recorded on the login page — can't navigate.");
  }

  await mkdir(path.dirname(outputPath), { recursive: true });
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(gotoUrl);
    await resolveLocator(page, loginEdge.authFormLocators.username).fill(credentials.username);
    await resolveLocator(page, loginEdge.authFormLocators.password).fill(credentials.password);
    await resolveLocator(page, loginEdge.locator).click();

    const destPage = map.pages[loginEdge.toPageId];
    if (destPage && loginEdge.postconditions.some((p) => p.assertionType === "url_matches")) {
      await page.waitForURL(new RegExp(destPage.urlPattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/:id/g, "[^/]+")));
    }

    await context.storageState({ path: outputPath });
  } finally {
    await browser.close();
  }
}
