import { useCallback, useEffect, useState } from "react";

/**
 * Light/dark mode (DESIGN.md section 3.1). Light is the default. Dark sets `data-mode="dark"`
 * on <html>, and theme.css turns that into `color-scheme: dark`, which every token follows
 * through `light-dark()`. Components never read the mode; only the toggle does.
 */

export type ColorMode = "light" | "dark" | "system";

const STORAGE_KEY = "rh-mode";
const DARK_QUERY = "(prefers-color-scheme: dark)";

/**
 * Runs in <head> before first paint so a stored dark choice never flashes light.
 * Keep it dependency-free and in sync with `apply` below.
 */
export const MODE_BOOT_SCRIPT = `(function(){var d=document.documentElement,m="light";try{m=localStorage.getItem("${STORAGE_KEY}")||"light"}catch(e){}var k=m==="dark"||(m==="system"&&window.matchMedia("${DARK_QUERY}").matches);d.dataset.mode=k?"dark":"light";d.dataset.modeChoice=m})();`;

function readChoice(): ColorMode {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === "dark" || stored === "system") return stored;
  } catch {
    // Storage blocked: fall back to the default.
  }
  return "light";
}

function apply(choice: ColorMode) {
  const dark = choice === "dark" || (choice === "system" && window.matchMedia(DARK_QUERY).matches);
  document.documentElement.dataset.mode = dark ? "dark" : "light";
  document.documentElement.dataset.modeChoice = choice;
}

/** The user's stored choice and a setter that persists and applies it. */
export function useColorMode() {
  // The server cannot know the stored choice; the boot script already applied it to <html>.
  const [mode, setModeState] = useState<ColorMode>("light");

  useEffect(() => setModeState(readChoice()), []);

  // "System" follows the OS while it is the active choice.
  useEffect(() => {
    if (mode !== "system") return;
    const query = window.matchMedia(DARK_QUERY);
    const onChange = () => apply("system");
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, [mode]);

  const setMode = useCallback((next: ColorMode) => {
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Storage blocked: the choice still applies for this page view.
    }
    apply(next);
    setModeState(next);
  }, []);

  return { mode, setMode };
}
