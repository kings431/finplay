/**
 * Couch mode: arrow keys, TV remotes (which send arrow keys), and gamepads
 * move focus spatially between controls; Enter/A activates; Back/B goes back.
 */

type Direction = "up" | "down" | "left" | "right";

const FOCUSABLE = 'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';
const TEXT_INPUT = /^(text|search|password|email|url|number|tel)$/;

let enabled = false;
let frame = 0;
const held: Record<string, number> = {};

function visible(element: Element) {
  const rect = element.getBoundingClientRect();
  if (rect.width < 2 || rect.height < 2) return false;
  const style = getComputedStyle(element);
  return style.visibility !== "hidden" && style.display !== "none" && !element.closest("[inert], [aria-hidden='true']");
}

function scope(): ParentNode {
  const menus = document.querySelectorAll(".menu-pop, .sheet-backdrop, .resume-card");
  return menus.length ? menus[menus.length - 1] : document;
}

function center(rect: DOMRect) {
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
}

function pick(from: Element, direction: Direction) {
  const origin = from.getBoundingClientRect();
  const at = center(origin);
  let best: { element: HTMLElement; score: number } | null = null;
  for (const element of scope().querySelectorAll<HTMLElement>(FOCUSABLE)) {
    if (element === from || !visible(element)) continue;
    const rect = element.getBoundingClientRect();
    const to = center(rect);
    let primary: number;
    let secondary: number;
    if (direction === "right") {
      if (to.x <= at.x + 1 || rect.left < origin.left + origin.width / 3) continue;
      primary = Math.max(0, rect.left - origin.right);
      secondary = Math.abs(to.y - at.y);
    } else if (direction === "left") {
      if (to.x >= at.x - 1 || rect.right > origin.right - origin.width / 3) continue;
      primary = Math.max(0, origin.left - rect.right);
      secondary = Math.abs(to.y - at.y);
    } else if (direction === "down") {
      if (to.y <= at.y + 1 || rect.top < origin.top + origin.height / 3) continue;
      primary = Math.max(0, rect.top - origin.bottom);
      secondary = Math.abs(to.x - at.x);
    } else {
      if (to.y >= at.y - 1 || rect.bottom > origin.bottom - origin.height / 3) continue;
      primary = Math.max(0, origin.top - rect.bottom);
      secondary = Math.abs(to.x - at.x);
    }
    const horizontal = direction === "left" || direction === "right";
    const score = primary + secondary * (horizontal ? 2.5 : 0.35);
    if (!best || score < best.score) best = { element, score };
  }
  return best?.element ?? null;
}

function focus(element: HTMLElement) {
  element.focus({ preventScroll: true });
  element.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
  const main = document.querySelector(".main");
  if (main?.contains(element)) {
    const rect = element.getBoundingClientRect();
    const view = main.getBoundingClientRect();
    if (rect.top < view.top + 80) main.scrollBy({ top: rect.top - view.top - 120, behavior: "smooth" });
    else if (rect.bottom > view.bottom - 40) main.scrollBy({ top: rect.bottom - view.bottom + 120, behavior: "smooth" });
  }
}

function first() {
  const root = scope();
  const candidates = [...root.querySelectorAll<HTMLElement>(root === document ? `.main ${FOCUSABLE}` : FOCUSABLE)].filter(visible);
  return candidates[0] ?? null;
}

export function move(direction: Direction) {
  const current = document.activeElement;
  const inScope = current instanceof HTMLElement && current !== document.body && scope().contains(current) && visible(current);
  const next = inScope ? pick(current, direction) : first();
  if (next) focus(next);
}

function back() {
  const open = document.querySelector(".menu-scrim, .sheet-backdrop");
  if (open) {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    return;
  }
  if (window.location.hash !== "#/" && window.location.hash !== "") window.history.back();
}

function onKey(event: KeyboardEvent) {
  if (!enabled || event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
  if (window.location.hash.startsWith("#/playing/") && !document.querySelector(".menu-pop, .sheet-backdrop")) return;
  const target = event.target as HTMLElement | null;
  const typing = target instanceof HTMLInputElement ? TEXT_INPUT.test(target.type) : target instanceof HTMLTextAreaElement;
  const selecting = target instanceof HTMLSelectElement;
  const directions: Record<string, Direction> = { ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right" };
  const direction = directions[event.key];
  if (direction) {
    if (typing && (direction === "left" || direction === "right")) return;
    if (selecting && (direction === "up" || direction === "down")) return;
    event.preventDefault();
    move(direction);
  } else if ((event.key === "Backspace" && !typing) || event.key === "BrowserBack" || event.key === "GoBack") {
    event.preventDefault();
    back();
  } else if (event.key === "Enter" && target instanceof HTMLElement && target.matches("[tabindex]:not(button):not(a)")) {
    event.preventDefault();
    target.click();
  }
}

function repeat(key: string, pressed: boolean, action: () => void, now: number, repeats = true) {
  if (!pressed) {
    delete held[key];
    return;
  }
  const since = held[key];
  if (since === undefined) {
    held[key] = repeats ? now + 380 : Number.POSITIVE_INFINITY;
    action();
  } else if (now >= since) {
    held[key] = now + 110;
    action();
  }
}

function pollPads(now: number) {
  frame = 0;
  if (!enabled) return;
  const pads = navigator.getGamepads?.() ?? [];
  for (const pad of pads) {
    if (!pad) continue;
    const button = (index: number) => pad.buttons[index]?.pressed === true;
    const [x = 0, y = 0] = pad.axes;
    const id = `${pad.index}:`;
    repeat(`${id}up`, button(12) || y < -0.55, () => move("up"), now);
    repeat(`${id}down`, button(13) || y > 0.55, () => move("down"), now);
    repeat(`${id}left`, button(14) || x < -0.55, () => move("left"), now);
    repeat(`${id}right`, button(15) || x > 0.55, () => move("right"), now);
    repeat(`${id}a`, button(0), () => (document.activeElement as HTMLElement | null)?.click(), now, false);
    repeat(`${id}b`, button(1), back, now, false);
  }
  if (pads.some(Boolean)) frame = requestAnimationFrame(pollPads);
}

function onPad() {
  if (enabled && !frame) frame = requestAnimationFrame(pollPads);
}

export function applyCouch(next: boolean) {
  enabled = next;
  document.documentElement.toggleAttribute("data-couch", next);
  window.removeEventListener("keydown", onKey);
  window.removeEventListener("gamepadconnected", onPad);
  if (frame) cancelAnimationFrame(frame);
  frame = 0;
  if (!next) return;
  window.addEventListener("keydown", onKey);
  window.addEventListener("gamepadconnected", onPad);
  onPad();
}
