"use client";

import { useSyncExternalStore } from "react";
import styles from "./theme-toggle.module.css";

type Choice = "system" | "light" | "dark";

export const THEME_KEY = "brain-theme";

/**
 * Fired whenever the theme changes in this tab.
 *
 * The `storage` event only reaches OTHER tabs, so something same-tab is
 * needed as well. The graph canvas listens for this too: Cytoscape resolves
 * the palette once when it mounts and cannot see a custom property change,
 * so without a nudge it keeps the old colours until it is remounted.
 */
export const THEME_EVENT = "brain:themechange";

/**
 * The inline script that runs before first paint.
 *
 * Exported as a string because it has to execute in the document head, ahead
 * of React, or the page renders in the system theme for a frame and then
 * snaps to the stored one. Everyone has seen that flash and it looks broken.
 *
 * Wrapped in try/catch: localStorage throws in a private window with site
 * data blocked, and a theme preference is not worth a blank page.
 */
export const themeScript = `
try {
  var t = localStorage.getItem(${JSON.stringify(THEME_KEY)});
  if (t === "light" || t === "dark") {
    document.documentElement.setAttribute("data-theme", t);
  }
} catch (e) {}
`.trim();

/**
 * The document element is the source of truth, not React state.
 *
 * The inline script above has already set the attribute by the time this
 * mounts, so reading it back is both correct and avoids the
 * read-storage-then-setState-in-an-effect pattern. `storage` keeps other
 * tabs in step.
 */
function subscribe(onChange: () => void) {
  window.addEventListener("storage", onChange);
  window.addEventListener(THEME_EVENT, onChange);
  return () => {
    window.removeEventListener("storage", onChange);
    window.removeEventListener(THEME_EVENT, onChange);
  };
}

function getSnapshot(): Choice {
  const value = document.documentElement.getAttribute("data-theme");
  return value === "light" || value === "dark" ? value : "system";
}

/** No document on the server, and no stored preference to read. */
function getServerSnapshot(): Choice {
  return "system";
}

const ORDER: Choice[] = ["system", "light", "dark"];
const LABEL: Record<Choice, string> = {
  system: "Match system",
  light: "Light",
  dark: "Dark",
};

/**
 * Three states, not two. "System" is a real choice and the default, so the
 * app follows the OS at night without anyone having to remember to switch.
 */
export default function ThemeToggle() {
  const choice = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  const apply = (next: Choice) => {
    const root = document.documentElement;
    if (next === "system") root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", next);

    try {
      if (next === "system") localStorage.removeItem(THEME_KEY);
      else localStorage.setItem(THEME_KEY, next);
    } catch {
      // The theme still applies for this page; it just will not persist.
    }

    window.dispatchEvent(new Event(THEME_EVENT));
  };

  return (
    <button
      type="button"
      className={styles.toggle}
      // A single cycling button, because a three-way segmented control is a
      // lot of chrome for something touched twice a year. The label carries
      // the full state for anyone who wonders.
      title={`Theme: ${LABEL[choice].toLowerCase()}. Click to change.`}
      aria-label={`Theme: ${LABEL[choice]}. Click to change.`}
      onClick={() => apply(ORDER[(ORDER.indexOf(choice) + 1) % ORDER.length])}
    >
      <Glyph choice={choice} />
    </button>
  );
}

function Glyph({ choice }: { choice: Choice }) {
  const common = {
    width: 15,
    height: 15,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.6,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
  };

  if (choice === "light") {
    return (
      <svg {...common}>
        <circle cx="12" cy="12" r="4.2" />
        <path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.2 5.2l1.4 1.4M17.4 17.4l1.4 1.4M18.8 5.2l-1.4 1.4M6.6 17.4l-1.4 1.4" />
      </svg>
    );
  }
  if (choice === "dark") {
    return (
      <svg {...common}>
        <path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z" />
      </svg>
    );
  }
  // System: a display, which is the thing being deferred to.
  return (
    <svg {...common}>
      <rect x="2.75" y="4" width="18.5" height="13" rx="2" />
      <path d="M8.5 21h7M12 17v4" />
    </svg>
  );
}
