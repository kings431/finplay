import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { Crash } from "./components/Crash";
import { loadSettings } from "./settings";
import { applyLowPower, applyTheme } from "./theme";
import { applyCouch } from "./couch";
import { applyPlatform } from "./components/TitleBar";
import { setDeviceName } from "./jellyfin";
import { deviceName } from "./player";
import "./styles.css";

const settings = loadSettings();
applyTheme(settings.theme);
applyCouch(settings.couchMode);
applyLowPower(settings.lowPower);
applyPlatform();

// Named before the first server request, so this computer is listed by name.
void deviceName()
  .then(setDeviceName)
  .finally(() =>
    createRoot(document.getElementById("root")!).render(
      <StrictMode>
        <Crash>
          <App />
        </Crash>
      </StrictMode>,
    ),
  );
