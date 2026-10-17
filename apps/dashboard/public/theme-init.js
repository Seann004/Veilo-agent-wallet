/* global document */
// Applies a saved light/dark choice before hydration; without one the system setting applies.
try {
  const theme = localStorage.getItem("veilo.theme");
  if (theme === "light" || theme === "dark") document.documentElement.dataset.theme = theme;
} catch {
  // Storage can be blocked (private windows, strict settings); the system setting then applies.
}
