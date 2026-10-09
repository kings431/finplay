import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { loadSettings } from "./settings";
import { applyTheme } from "./theme";
import { applyCouch } from "./couch";
import "./styles.css";

const settings = loadSettings();
applyTheme(settings.theme);
applyCouch(settings.couchMode);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
