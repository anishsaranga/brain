/**
 * Palette access for Cytoscape.
 *
 * Cytoscape styles are plain JavaScript values. It cannot read a CSS custom
 * property, so the tokens have to be resolved to concrete strings and handed
 * over, which means the canvas holds a SNAPSHOT of the palette taken when it
 * mounted. Change the theme and the graph keeps the old colours until
 * something rebuilds it, so `watchTheme` exists to say when that happened.
 *
 * Shared by both canvases rather than duplicated, because the four names
 * below are already load-bearing in a way that is easy to break: renaming a
 * token in globals.css produces no error here, just silently wrong colours.
 */

/** Fired by the theme toggle after it changes the document attribute. */
export const THEME_EVENT = "brain:themechange";

export interface ThemeColors {
  bg: string;
  fg: string;
  muted: string;
  line: string;
  accent: string;
  danger: string;
  isDark: boolean;
}

export function themeColors(el: HTMLElement): ThemeColors {
  const style = getComputedStyle(el);
  const read = (name: string, fallback: string) =>
    style.getPropertyValue(name).trim() || fallback;

  const bg = read("--bg", "#ffffff");

  return {
    bg,
    fg: read("--fg", "#111418"),
    muted: read("--muted", "#5c6672"),
    line: read("--line", "#e3e7ec"),
    accent: read("--accent", "#2f6b4f"),
    danger: read("--danger", "#b4302a"),
    // Derived from the resolved background rather than from the attribute or
    // the media query, so it stays right however the theme was arrived at.
    isDark: isDarkColor(bg),
  };
}

/**
 * Rough perceived lightness of a hex colour.
 *
 * Only ever asked about `--bg`, which is a literal hex in globals.css. A
 * non-hex value falls back to "light", which is the safer guess: the derived
 * colours stay readable on a light canvas either way.
 */
function isDarkColor(value: string): boolean {
  const hex = value.replace("#", "").trim();
  if (hex.length !== 3 && hex.length !== 6) return false;
  const full =
    hex.length === 3
      ? hex
          .split("")
          .map((c) => c + c)
          .join("")
      : hex;
  const n = Number.parseInt(full, 16);
  if (Number.isNaN(n)) return false;
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 < 0.5;
}

/**
 * Call `onChange` whenever the effective theme changes.
 *
 * Two sources, and both are needed: the toggle fires THEME_EVENT when the
 * user picks a theme, and the media query fires when the OS flips while the
 * app is set to follow it. Watching only the first means the graph goes
 * stale at sunset on a machine with automatic dark mode.
 *
 * Returns an unsubscribe function.
 */
export function watchTheme(onChange: () => void): () => void {
  const media = window.matchMedia("(prefers-color-scheme: dark)");

  const handler = () => onChange();
  window.addEventListener(THEME_EVENT, handler);
  media.addEventListener("change", handler);

  return () => {
    window.removeEventListener(THEME_EVENT, handler);
    media.removeEventListener("change", handler);
  };
}
