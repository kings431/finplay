import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { Crash } from "./components/Crash";
import { loadSettings } from "./settings";
import { applyLowPower, applyTheme } from "./theme";
import { applyCouch } from "./couch";
import { applyPlatform } from "./components/TitleBar";
import "./styles.css";

const settings = loadSettings();
applyTheme(settings.theme);
applyCouch(settings.couchMode);
applyLowPower(settings.lowPower);
applyPlatform();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Crash>
      <App />
    </Crash>
  </StrictMode>,
);
