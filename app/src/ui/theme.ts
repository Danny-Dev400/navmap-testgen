import { useEffect, useState } from "react";

/* Light / dark theme. The preference lives in this browser (localStorage); "system" follows the OS.
   The effective theme is the data-theme attribute on <html>, which tokens.css keys the dark palette
   on. index.html applies it before the first paint (no light flash in dark mode) — keep the two in
   sync. */

export type ThemePref = "system" | "light" | "dark";

const STORAGE_KEY = "navmap.theme";
const darkQuery = () => window.matchMedia("(prefers-color-scheme: dark)");

export function loadThemePref(): ThemePref {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return value === "light" || value === "dark" ? value : "system";
  } catch {
    return "system";
  }
}

function applyTheme(pref: ThemePref) {
  const dark = pref === "dark" || (pref === "system" && darkQuery().matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
}

const listeners = new Set<(pref: ThemePref) => void>();

export function setThemePref(pref: ThemePref) {
  try {
    if (pref === "system") localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, pref);
  } catch {
    // storage blocked: the choice still applies until the page reloads
  }
  applyTheme(pref);
  for (const listener of listeners) listener(pref);
}

/** Applies the saved theme, then keeps it current: an OS switch while on "system", and a choice made
 *  in another tab. */
export function initTheme() {
  applyTheme(loadThemePref());
  darkQuery().addEventListener("change", () => {
    if (loadThemePref() === "system") applyTheme("system");
  });
  window.addEventListener("storage", (e) => {
    if (e.key !== STORAGE_KEY && e.key !== null) return;
    const pref = loadThemePref();
    applyTheme(pref);
    for (const listener of listeners) listener(pref);
  });
}

export function useThemePref(): [ThemePref, (pref: ThemePref) => void] {
  const [pref, setPref] = useState(loadThemePref);
  useEffect(() => {
    listeners.add(setPref);
    return () => {
      listeners.delete(setPref);
    };
  }, []);
  return [pref, setThemePref];
}
