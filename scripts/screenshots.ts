import { readFile } from "node:fs/promises";
import path from "node:path";
import type { ExplorationRun } from "../src/types.js";
import type { NavigationMap } from "../src/navmap-types.js";

export const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};

export async function inlineScreenshotsForPaths(paths: Iterable<string>): Promise<Map<string, string>> {
  const screenshotDataUris = new Map<string, string>();
  for (const screenshotPath of paths) {
    const mime = MIME_BY_EXT[path.extname(screenshotPath).toLowerCase()];
    if (!mime) {
      console.warn(`Skipping screenshot with unrecognized extension: ${screenshotPath}`);
      continue;
    }
    try {
      const bytes = await readFile(screenshotPath);
      screenshotDataUris.set(screenshotPath, `data:${mime};base64,${bytes.toString("base64")}`);
    } catch {
      console.warn(`Skipping missing/unreadable screenshot: ${screenshotPath}`);
    }
  }
  return screenshotDataUris;
}

export async function inlineScreenshots(run: ExplorationRun): Promise<Map<string, string>> {
  const screenshotPaths = new Set<string>();
  for (const node of Object.values(run.stepNodes)) {
    if (node.screenshot) screenshotPaths.add(node.screenshot);
  }
  return inlineScreenshotsForPaths(screenshotPaths);
}

export async function inlineNavMapScreenshots(map: NavigationMap): Promise<Map<string, string>> {
  const screenshotPaths = new Set<string>();
  for (const edge of Object.values(map.edges)) {
    if (edge.screenshot) screenshotPaths.add(edge.screenshot);
    if (edge.screenshotBefore) screenshotPaths.add(edge.screenshotBefore);
  }
  return inlineScreenshotsForPaths(screenshotPaths);
}
