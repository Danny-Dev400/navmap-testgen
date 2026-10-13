import type { Locator } from "../../src/navmap-types";

export function locatorText(locator: Locator): string {
  switch (locator.strategy) {
    case "role":
      return `role=${locator.role}${locator.name ? ` name="${locator.name}"` : ""}`;
    case "text":
      return `text="${locator.text}"`;
    case "label":
      return `label="${locator.label}"`;
    case "placeholder":
      return `placeholder="${locator.placeholder}"`;
    case "testId":
      return `testId="${locator.testId}"`;
    case "css":
      return `css="${locator.css}"`;
  }
}
