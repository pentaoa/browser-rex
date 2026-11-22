// Run before styles load so a saved preference also applies to the first paint.
// Keep this entry independent of the terminal engine and workspace bootstrap.
type Preference = "system" | "light" | "dark";
const storageKey = "rexweb:theme";
const system = matchMedia("(prefers-color-scheme: dark)");
const root = document.documentElement;
const valid = (value: unknown): value is Preference => value === "system" || value === "light" || value === "dark";
function readPreference(): Preference {
  try {
    const value = localStorage.getItem(storageKey);
    if (valid(value)) return value;
  } catch { /* Private/restricted storage still permits in-memory switching. */ }
  return "system";
}
let preference = readPreference();
function updateButtons() {
  document.querySelectorAll<HTMLButtonElement>("[data-theme-choice]").forEach(button => {
    button.setAttribute("aria-pressed", String(button.dataset.themeChoice === preference));
  });
}
function apply(userInitiated = false) {
  const theme = preference === "system" ? (system.matches ? "dark" : "light") : preference;
  const changed = root.dataset.theme !== theme;
  root.dataset.theme = theme;
  root.dataset.themePreference = preference;
  root.style.colorScheme = theme;
  const color = theme === "dark" ? "#3b3b3b" : "#e4e4e5";
  root.style.backgroundColor = color;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", color);
  updateButtons();
  if (changed || userInitiated) window.dispatchEvent(new CustomEvent("rexweb:theme", {detail: {userInitiated}}));
}
document.addEventListener("click", event => {
  const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>("button[data-theme-choice]") : null;
  if (!valid(button?.dataset.themeChoice)) return;
  preference = button.dataset.themeChoice;
  try { localStorage.setItem(storageKey, preference); } catch { /* Keep the selection for this page. */ }
  apply(true);
});
system.addEventListener("change", () => { if (preference === "system") apply(); });
window.addEventListener("storage", event => {
  if (event.key !== storageKey && event.key !== null) return;
  preference = readPreference();
  apply();
});
document.addEventListener("DOMContentLoaded", updateButtons, {once: true});
apply();
export {};
