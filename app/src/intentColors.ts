import type { IntentCategory } from "../../src/navmap-types";

export const INTENT_COLORS: Record<IntentCategory, string> = {
  navigation: "#57606a",
  auth: "#0969da",
  search_filter: "#0d9488",
  create: "#1a7f37",
  read: "#6e7781",
  update: "#9a6700",
  delete: "#cf222e",
  form_submit: "#8250df",
  state_toggle: "#1b7c83",
  external: "#bf3989",
  other: "#6e7781",
};
