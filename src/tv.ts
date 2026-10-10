/**
 * The Samsung TV build (`vite --mode tv`). The remote sends arrows and Enter as
 * usual; Back and the media keys arrive as Tizen key codes, translated here to
 * standard key names so the rest of the app only checks `event.key`.
 */
import { focusFirst } from "./couch";

export const tv = import.meta.env.MODE === "tv";

/** Pages fill in after they appear, so try a few times. */
function focusSoon() {
  for (const delay of [150, 600, 1500, 3000]) window.setTimeout(focusFirst, delay);
}

type Tizen = {
  tvinputdevice?: { registerKey(name: string): void };
  application?: { getCurrentApplication(): { exit(): void } };
};

const KEYS: Record<number, string> = {
  10009: "GoBack",
  10252: "MediaPlayPause",
  415: "MediaPlay",
  19: "MediaPause",
  413: "MediaStop",
  417: "MediaFastForward",
  412: "MediaRewind",
  10232: "MediaTrackPrevious",
  10233: "MediaTrackNext",
};

function tizen() {
  return (window as unknown as { tizen?: Tizen }).tizen;
}

function polyfill() {
  // Tizen 6.5 ships Chromium 85.
  if (typeof crypto.randomUUID !== "function") {
    Object.defineProperty(crypto, "randomUUID", {
      configurable: true,
      value() {
        const bytes = crypto.getRandomValues(new Uint8Array(16));
        bytes[6] = (bytes[6] & 0x0f) | 0x40;
        bytes[8] = (bytes[8] & 0x3f) | 0x80;
        const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
        return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
      },
    });
  }
  if (!Array.prototype.at) {
    Object.defineProperty(Array.prototype, "at", {
      configurable: true,
      writable: true,
      value(this: unknown[], index: number) {
        const at = Math.trunc(index) || 0;
        return this[at < 0 ? this.length + at : at];
      },
    });
  }
  if (!Object.hasOwn) {
    Object.defineProperty(Object, "hasOwn", {
      configurable: true,
      writable: true,
      value: (target: object, key: PropertyKey) => Object.prototype.hasOwnProperty.call(target, key),
    });
  }
}

export function installTv() {
  if (!tv) return;
  polyfill();
  document.documentElement.toggleAttribute("data-tv", true);
  window.addEventListener("hashchange", focusSoon);
  focusSoon();
  const device = tizen()?.tvinputdevice;
  for (const name of ["MediaPlayPause", "MediaPlay", "MediaPause", "MediaStop", "MediaFastForward", "MediaRewind", "MediaTrackPrevious", "MediaTrackNext"]) {
    try {
      device?.registerKey(name);
    } catch {
      // Not every remote has every key.
    }
  }
  window.addEventListener(
    "keydown",
    (event) => {
      const key = KEYS[event.keyCode];
      if (!key || event.key === key) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      (event.target ?? window).dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
    },
    true,
  );
}

/** Back on the home screen leaves the app, as TV apps do. */
export function exitApp() {
  try {
    tizen()?.application?.getCurrentApplication().exit();
  } catch {
    // Outside the TV there is nothing to exit.
  }
}
