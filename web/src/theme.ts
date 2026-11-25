// Run before styles load so a saved preference also applies to the first paint.
// Keep this entry independent of the terminal engine and workspace bootstrap.
type Preference = "system" | "light" | "dark";
const modeKey = "rexweb:theme";
const paletteKey = "rexweb:dark-palette";
const darkChrome = { obsidian: "#191a1e", ocean: "#212a3b", graphite: "#35363a" };
type Palette = keyof typeof darkChrome;
const system = matchMedia("(prefers-color-scheme: dark)");
const root = document.documentElement;
const isMode = (value: unknown): value is Preference => value === "system" || value === "light" || value === "dark";
const isPalette = (value: unknown): value is Palette => typeof value === "string" && Object.hasOwn(darkChrome, value);

function stored(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}
function remember(key: string, value: string) {
  try { localStorage.setItem(key, value); } catch { /* Keep the selection for this page. */ }
}
function readMode(): Preference {
  const value = stored(modeKey);
  return isMode(value) ? value : "system";
}
function readPalette(): Palette {
  const value = stored(paletteKey);
  return isPalette(value) ? value : "obsidian";
}
let preference = readMode();
let palette = readPalette();

function updateButtons() {
  document.querySelectorAll<HTMLButtonElement>("[data-theme-choice], [data-palette-choice]").forEach(button => {
    const selected = button.dataset.themeChoice === preference || button.dataset.paletteChoice === palette;
    button.setAttribute("aria-pressed", String(selected));
  });
}
function apply(userInitiated = false) {
  const theme = preference === "system" ? (system.matches ? "dark" : "light") : preference;
  const changed = root.dataset.theme !== theme || (theme === "dark" && root.dataset.palette !== palette);
  root.dataset.theme = theme;
  root.dataset.themePreference = preference;
  root.dataset.palette = palette;
  root.style.colorScheme = theme;
  const color = theme === "dark" ? darkChrome[palette] : "#e4e4e5";
  root.style.backgroundColor = color;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", color);
  updateButtons();
  if (changed || userInitiated) window.dispatchEvent(new CustomEvent("rexweb:theme", {detail: {userInitiated}}));
}
document.addEventListener("click", event => {
  if (!(event.target instanceof Element)) return;
  const button = event.target.closest<HTMLButtonElement>("button[data-theme-choice], button[data-palette-choice]");
  if (isMode(button?.dataset.themeChoice)) {
    preference = button.dataset.themeChoice;
    remember(modeKey, preference);
  } else if (isPalette(button?.dataset.paletteChoice)) {
    palette = button.dataset.paletteChoice;
    remember(paletteKey, palette);
  } else {
    return;
  }
  apply(true);
});
system.addEventListener("change", () => { if (preference === "system") apply(); });
window.addEventListener("storage", event => {
  if (event.key !== modeKey && event.key !== paletteKey && event.key !== null) return;
  if (event.key !== paletteKey) preference = readMode();
  if (event.key !== modeKey) palette = readPalette();
  apply();
});
document.addEventListener("DOMContentLoaded", updateButtons, {once: true});
apply();
export {};
