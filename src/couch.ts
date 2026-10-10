/**
 * Couch mode: arrow keys, TV remotes (which send arrow keys), and gamepads
 * move focus spatially between controls; Enter/A activates; Back/B goes back.
 */

import { exitApp, tv } from "./tv";

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
  const menus = document.querySelectorAll(".web-osd, .menu-pop, .sheet-backdrop, .resume-card");
  return menus.length ? menus[menus.length - 1] : document;
}

function center(rect: DOMRect) {
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
}

/** The sidebar or the page. Up and down stay inside one, so a sidebar button
 * that happens to sit a little lower never wins over the next row of cards. */
function region(element: Element) {
  return element.closest(".sidebar, .main");
}

function pick(from: Element, direction: Direction) {
  const origin = from.getBoundingClientRect();
  const at = center(origin);
  const within = direction === "up" || direction === "down" ? region(from) : null;
  let best: { element: HTMLElement; score: number } | null = null;
  for (const element of scope().querySelectorAll<HTMLElement>(FOCUSABLE)) {
    if (element === from || !visible(element)) continue;
    if (within && !within.contains(element)) continue;
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

/** One smooth scroll per container: two at once on the page cancel each other
 * and focus ends up off screen. */
function focus(element: HTMLElement) {
  element.focus({ preventScroll: true });
  const main = document.querySelector(".main");
  if (!main?.contains(element)) {
    element.scrollIntoView({ block: "nearest", inline: "nearest" });
    return;
  }
  const rect = element.getBoundingClientRect();
  const track = element.closest(".row-track");
  if (track) {
    const lane = track.getBoundingClientRect();
    const edge = 56;
    if (rect.left < lane.left + edge) track.scrollBy({ left: rect.left - lane.left - edge, behavior: "smooth" });
    else if (rect.right > lane.right - edge) track.scrollBy({ left: rect.right - lane.right + edge, behavior: "smooth" });
  }
  const view = main.getBoundingClientRect();
  let top: number | null = null;
  // Nothing above it: show the page from the very top, hero included.
  if (!pick(element, "up")) top = 0;
  else if (rect.top < view.top + 80) top = main.scrollTop + rect.top - view.top - 120;
  else if (rect.bottom > view.bottom - 40) top = main.scrollTop + rect.bottom - view.bottom + 120;
  if (top !== null) main.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
}

const IN_MAIN = FOCUSABLE.split(", ")
  .map((selector) => `.main ${selector}`)
  .join(", ");

function first() {
  const root = scope();
  const candidates = [...root.querySelectorAll<HTMLElement>(root === document ? IN_MAIN : FOCUSABLE)].filter(visible);
  return candidates[0] ?? null;
}

/** Remotes have no pointer, so a new screen starts with its first control focused. */
export function focusFirst() {
  const current = document.activeElement;
  if (current instanceof HTMLElement && current !== document.body && current.isConnected && visible(current)) return;
  const next = first();
  if (next) focus(next);
}

export function move(direction: Direction) {
  const current = document.activeElement;
  const inScope = current instanceof HTMLElement && current !== document.body && scope().contains(current) && visible(current);
  const next = inScope ? pick(current, direction) : first();
  if (next) focus(next);
  else if (inScope && direction === "up" && region(current)?.matches(".main")) {
    document.querySelector(".main")?.scrollTo({ top: 0, behavior: "smooth" });
  }
}

function back() {
  const open = document.querySelector(".menu-scrim, .sheet-backdrop");
  if (open) {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    return;
  }
  if (window.location.hash !== "#/" && window.location.hash !== "") window.history.back();
  else if (tv) exitApp();
}

function onKey(event: KeyboardEvent) {
  if (!enabled || event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
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

/** 20 checks a second is plenty for menu navigation and lets the CPU idle,
 * unlike polling on every display frame. */
const PAD_POLL_MS = 50;
const PAD_HIDDEN_POLL_MS = 500;

function schedulePads() {
  frame = window.setTimeout(pollPads, document.hidden ? PAD_HIDDEN_POLL_MS : PAD_POLL_MS);
}

function pollPads() {
  frame = 0;
  if (!enabled) return;
  const now = performance.now();
  // A GamepadList rather than an array before Chromium 89 (Samsung TVs up to 2022).
  const pads = Array.from(navigator.getGamepads?.() ?? []);
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
  if (pads.some(Boolean)) schedulePads();
}

function onPad() {
  if (enabled && !frame) schedulePads();
}

export function applyCouch(next: boolean) {
  enabled = next;
  document.documentElement.toggleAttribute("data-couch", next);
  window.removeEventListener("keydown", onKey);
  window.removeEventListener("gamepadconnected", onPad);
  if (frame) window.clearTimeout(frame);
  frame = 0;
  if (!next) return;
  window.addEventListener("keydown", onKey);
  window.addEventListener("gamepadconnected", onPad);
  onPad();
}
