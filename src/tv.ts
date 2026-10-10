/**
 * The Samsung TV build (`vite --mode tv`). The remote sends arrows and Enter as
 * usual; Back and the media keys arrive as Tizen key codes, translated here to
 * standard key names so the rest of the app only checks `event.key`.
 */
export const tv = import.meta.env.MODE === "tv";

/** Pages fill in after they appear, so try a few times. */
function focusSoon(focusFirst: () => void) {
  for (const delay of [150, 600, 1500, 3000]) window.setTimeout(focusFirst, delay);
}

type Tizen = {
  tvinputdevice?: {
    registerKey(name: string): void;
    registerKeyBatch?(names: string[], success?: () => void, error?: (error: unknown) => void): void;
    getSupportedKeys?(): { name: string }[];
  };
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
  // The on-screen keyboard's Done and Cancel.
  65376: "Accept",
  65385: "Cancel",
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

/** Takes couch mode's `focusFirst` rather than importing it: couch mode reads
 * `tv` as it loads, so the two modules can't import each other. */
export function installTv(focusFirst: () => void) {
  if (!tv) return;
  polyfill();
  document.documentElement.toggleAttribute("data-tv", true);
  window.addEventListener("hashchange", () => focusSoon(focusFirst));
  focusSoon(focusFirst);
  // Slow pages, controls removed while focused, and menus that just opened all
  // leave the remote with nothing to move from.
  window.setInterval(focusFirst, 700);
  registerMediaKeys();
  window.addEventListener(
    "keydown",
    (event) => {
      const key = KEYS[event.keyCode];
      if (!key || event.key === key) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      (event.target ?? window).dispatchEvent(new KeyboardEvent("keydown", { key, repeat: event.repeat, bubbles: true, cancelable: true }));
    },
    true,
  );
}

/** Tizen keeps media keys for itself unless the app claims them (which needs
 * the tv.inputdevice privilege). A batch fails whole if one name is unknown,
 * so only keys this TV supports are asked for. */
function registerMediaKeys() {
  const device = tizen()?.tvinputdevice;
  if (!device) return;
  let names = Object.values(KEYS).filter((name) => name.startsWith("Media"));
  try {
    const supported = new Set((device.getSupportedKeys?.() ?? []).map((key) => key.name));
    if (supported.size) names = names.filter((name) => supported.has(name));
  } catch {
    // Older firmware: try them all.
  }
  const oneByOne = () => {
    for (const name of names) {
      try {
        device.registerKey(name);
      } catch {
        // Not every remote has every key.
      }
    }
  };
  if (!device.registerKeyBatch) return oneByOne();
  try {
    device.registerKeyBatch(names, undefined, oneByOne);
  } catch {
    oneByOne();
  }
}

/** Back on the home screen leaves the app, as TV apps do. */
export function exitApp() {
  try {
    tizen()?.application?.getCurrentApplication().exit();
  } catch {
    // Outside the TV there is nothing to exit.
  }
}
