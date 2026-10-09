import type { Theme } from "./types";

const query = window.matchMedia("(prefers-color-scheme: dark)");
let current: Theme = "dark";

function resolved(theme: Theme) {
  if (theme === "system") return query.matches ? "dark" : "light";
  return theme;
}

function paint() {
  const name = resolved(current);
  const root = document.documentElement;
  root.dataset.theme = name;
  root.style.colorScheme = name === "light" ? "light" : "dark";
}

query.addEventListener("change", () => {
  if (current === "system") paint();
});

export function applyTheme(theme: Theme) {
  current = theme;
  paint();
}
