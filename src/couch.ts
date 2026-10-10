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

/** A held key moves focus at most this often, so it steps rather than races
 * and a slow TV never works through a backlog of repeats after release. */
const REPEAT_MS = 120;
let lastMove = 0;

/** Where a focused row's top sits, as a share of the page's height. */
const ROW_TOP = 0.12;

/** Card rows hold most of a page's controls. A Home `.row` is measured as a
 * whole: its own box is laid out even while content-visibility skips what is inside. */
const LANE = ".row, .row-track";
/** How far a card may sit outside its row's box. */
const LANE_SLACK = 40;

function shown(element: Element) {
  const style = getComputedStyle(element);
  return style.visibility !== "hidden" && style.display !== "none" && !element.closest("[inert], [aria-hidden='true']");
}

function visible(element: Element) {
  const rect = element.getBoundingClientRect();
  return rect.width >= 2 && rect.height >= 2 && shown(element);
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

/**
 * Measuring every card on a long page takes a TV most of a second, and cards in
 * rows that content-visibility skipped force those rows to lay out. So each row
 * is measured once, and skipped whole when nothing in it could beat the best
 * match so far.
 */
function pick(from: Element, direction: Direction) {
  const origin = from.getBoundingClientRect();
  const at = center(origin);
  const horizontal = direction === "left" || direction === "right";
  const within = horizontal ? null : region(from);
  const root = scope();
  type Match = { element: HTMLElement; score: number };
  let best = null as Match | null;
  // Left and right stay on the same line when they can, so a wide control on
  // the next row never beats buttons further along this one.
  let level = null as Match | null;
  const consider = (element: HTMLElement) => {
    if (element === from || (within && !within.contains(element))) return;
    const rect = element.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return;
    const to = center(rect);
    let primary: number;
    let secondary: number;
    if (direction === "right") {
      if (to.x <= at.x + 1 || rect.left < origin.left + origin.width / 3) return;
      primary = Math.max(0, rect.left - origin.right);
      secondary = Math.abs(to.y - at.y);
    } else if (direction === "left") {
      if (to.x >= at.x - 1 || rect.right > origin.right - origin.width / 3) return;
      primary = Math.max(0, origin.left - rect.right);
      secondary = Math.abs(to.y - at.y);
    } else if (direction === "down") {
      if (to.y <= at.y + 1 || rect.top < origin.top + origin.height / 3) return;
      primary = Math.max(0, rect.top - origin.bottom);
      secondary = Math.abs(to.x - at.x);
    } else {
      if (to.y >= at.y - 1 || rect.bottom > origin.bottom - origin.height / 3) return;
      primary = Math.max(0, origin.top - rect.bottom);
      secondary = Math.abs(to.x - at.x);
    }
    if (!shown(element)) return;
    const score = primary + secondary * (horizontal ? 2.5 : 0.35);
    if (!best || score < best.score) best = { element, score };
    if (horizontal && rect.top < origin.bottom && rect.bottom > origin.top && (!level || score < level.score)) level = { element, score };
  };
  const lanes: { cards: NodeListOf<HTMLElement>; bound: number; level: boolean }[] = [];
  const inLane = new Set<Element>();
  for (const lane of root.querySelectorAll<HTMLElement>(LANE)) {
    if (lane.parentElement?.closest(LANE)) continue;
    const cards = lane.querySelectorAll<HTMLElement>(FOCUSABLE);
    cards.forEach((card) => inLane.add(card));
    if (!cards.length || (within && !within.contains(lane))) continue;
    const box = lane.getBoundingClientRect();
    const top = box.top - LANE_SLACK;
    const bottom = box.bottom + LANE_SLACK;
    // The lowest score any card in the row could reach.
    let bound: number;
    if (direction === "down") {
      if (bottom <= at.y + 1) continue;
      bound = Math.max(0, top - origin.bottom);
    } else if (direction === "up") {
      if (top >= at.y - 1) continue;
      bound = Math.max(0, origin.top - bottom);
    } else {
      bound = 2.5 * Math.max(0, top - at.y, at.y - bottom);
    }
    lanes.push({ cards, bound, level: horizontal && top < origin.bottom && bottom > origin.top });
  }
  for (const element of root.querySelectorAll<HTMLElement>(FOCUSABLE)) if (!inLane.has(element)) consider(element);
  lanes.sort((a, b) => a.bound - b.bound);
  for (const lane of lanes) {
    if (lane.level ? level && lane.bound >= level.score : level || (best && lane.bound >= best.score)) continue;
    lane.cards.forEach(consider);
  }
  return (level ?? best)?.element ?? null;
}

type Axis = "left" | "top";
type Glide = { axis: Axis; from: number; to: number; start: number; duration: number };

/** A TV's native smooth scroll runs long and can't be retargeted, so presses
 * there glide in short eased steps; a press mid-glide carries on from where
 * the last one got to. */
const GLIDE_MS = 220;
const RETARGET_MS = 160;
const glides = new Map<HTMLElement, Glide>();
let gliding = 0;

const ease = (t: number) => 1 - (1 - t) ** 3;

function stepGlides(now: number) {
  gliding = 0;
  for (const [element, glide] of glides) {
    if (!glide.start) glide.start = now;
    const t = Math.min(1, (now - glide.start) / glide.duration);
    const at = Math.round(glide.from + (glide.to - glide.from) * ease(t));
    if (glide.axis === "left") element.scrollLeft = at;
    else element.scrollTop = at;
    if (t >= 1 || !element.isConnected) glides.delete(element);
  }
  if (glides.size) gliding = requestAnimationFrame(stepGlides);
}

/** One scroll per container: two at once on the page cancel each other and
 * focus ends up off screen. */
function glideTo(element: HTMLElement, axis: Axis, to: number) {
  const max = axis === "left" ? element.scrollWidth - element.clientWidth : element.scrollHeight - element.clientHeight;
  const target = Math.round(Math.max(0, Math.min(max, to)));
  if (!tv) {
    element.scrollTo({ [axis]: target, behavior: "smooth" });
    return;
  }
  const running = glides.get(element);
  if (running?.to === target) return;
  const from = axis === "left" ? element.scrollLeft : element.scrollTop;
  if (!running && Math.abs(target - from) < 1) return;
  glides.set(element, { axis, from, to: target, start: 0, duration: running ? RETARGET_MS : GLIDE_MS });
  if (!gliding) gliding = requestAnimationFrame(stepGlides);
}

/**
 * Scrolls by a fixed rule rather than just enough, so the screen moves the
 * same way on every press: a card lines up where its row's first card starts,
 * and a row of cards sits at the same height on the page.
 */
function focus(element: HTMLElement) {
  element.focus({ preventScroll: true });
  const main = document.querySelector<HTMLElement>(".main");
  if (!main?.contains(element)) {
    element.scrollIntoView({ block: "nearest", inline: "nearest" });
    return;
  }
  const rect = element.getBoundingClientRect();
  const track = element.closest<HTMLElement>(".row-track");
  const lead = track?.firstElementChild;
  if (track && lead) glideTo(track, "left", rect.left - lead.getBoundingClientRect().left);
  const view = main.getBoundingClientRect();
  const row = element.closest(".row");
  let top: number | null = null;
  if (row) {
    const box = row.getBoundingClientRect();
    const offset = main.scrollTop + box.top - view.top;
    // A row that fits on the first screen keeps the page at its top.
    top = offset + box.height <= view.height ? 0 : offset - view.height * ROW_TOP;
  }
  // Nothing above it: show the page from the very top, hero included.
  else if (!pick(element, "up")) top = 0;
  else if (rect.top < view.top + 80) top = main.scrollTop + rect.top - view.top - 120;
  else if (rect.bottom > view.bottom - 40) top = main.scrollTop + rect.bottom - view.bottom + 120;
  if (top !== null) glideTo(main, "top", top);
}

const IN_MAIN = FOCUSABLE.split(", ")
  .map((selector) => `.main ${selector}`)
  .join(", ");

/** Prefers the page over the sidebar; screens without one (sign-in, profiles) use anything. */
function first() {
  const root = scope();
  const firstOf = (selector: string) => [...root.querySelectorAll<HTMLElement>(selector)].find(visible) ?? null;
  if (root !== document) return firstOf(FOCUSABLE);
  // While a page is still loading, wait for it rather than landing in the sidebar.
  if (document.querySelector(".main")) return firstOf(".main .btn-play:not([disabled])") ?? firstOf(IN_MAIN);
  return firstOf(FOCUSABLE);
}

/** Remotes have no pointer, so a new screen starts with its first control focused. */
export function focusFirst() {
  const current = document.activeElement;
  const root = scope();
  const inside = root === document || (current instanceof Node && root.contains(current));
  if (inside && current instanceof HTMLElement && current !== document.body && current.isConnected && visible(current)) return;
  const next = first();
  if (next) focus(next);
}

/** The page's main play button, if it is on screen. */
function onScreenPlay() {
  const view = document.querySelector(".main")?.getBoundingClientRect();
  if (!view) return null;
  return (
    [...document.querySelectorAll<HTMLElement>(".main .btn-play:not([disabled])")].find((element) => {
      const rect = element.getBoundingClientRect();
      return visible(element) && rect.top >= view.top && rect.bottom <= view.bottom;
    }) ?? null
  );
}

export function move(direction: Direction) {
  const current = document.activeElement;
  const inScope = current instanceof HTMLElement && current !== document.body && scope().contains(current) && visible(current);
  // Leaving the sidebar lands on the page's play button rather than whatever
  // sits nearest its edge, like the hero's arrows on Home.
  const entering = inScope && scope() === document && direction === "right" && current.closest(".sidebar") ? onScreenPlay() : null;
  const next = entering ?? (inScope ? pick(current, direction) : first());
  if (next) focus(next);
  else if (inScope && direction === "up" && region(current)?.matches(".main")) {
    const main = document.querySelector<HTMLElement>(".main");
    if (main) glideTo(main, "top", 0);
  }
}

/** Left and right step through a dropdown's options in place, so a remote can
 * change it without opening the list. Returns false at either end. */
function cycle(select: HTMLSelectElement, direction: Direction) {
  const step = direction === "right" ? 1 : -1;
  let index = select.selectedIndex + step;
  while (select.options[index]?.disabled) index += step;
  if (index < 0 || index >= select.options.length) return false;
  select.selectedIndex = index;
  select.dispatchEvent(new Event("change", { bubbles: true }));
  return true;
}

/** Up and down always leave a dropdown; opening it would trap them in its list. */
function navigate(direction: Direction, repeated: boolean) {
  if (repeated && performance.now() - lastMove < REPEAT_MS) return;
  const current = document.activeElement;
  if (current instanceof HTMLSelectElement && (direction === "left" || direction === "right")) {
    // Past the last option a fresh press moves on; holding the key stops at the end.
    if (cycle(current, direction) || repeated) {
      lastMove = performance.now();
      return;
    }
  }
  move(direction);
  // Timed from when the move is done, so repeats that queued up behind it are dropped.
  lastMove = performance.now();
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
  const directions: Record<string, Direction> = { ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right" };
  const direction = directions[event.key];
  if (direction) {
    // The TV keyboard takes the arrows while it is open; with it closed there is
    // no caret to move, so the arrows leave the field.
    if (typing && !tv && (direction === "left" || direction === "right")) return;
    event.preventDefault();
    navigate(direction, event.repeat);
  } else if ((event.key === "Backspace" && !typing) || event.key === "BrowserBack" || event.key === "GoBack") {
    event.preventDefault();
    back();
  } else if (tv && typing && target && event.key === "Enter") {
    // OK on a field opens the TV keyboard instead of submitting the form.
    event.preventDefault();
    target.blur();
    target.focus();
  } else if (tv && typing && event.key === "Accept") {
    // Done on the TV keyboard moves on to the next control, below or beside.
    event.preventDefault();
    move("down");
    if (document.activeElement === target) move("right");
  } else if (event.key === "Enter" && target instanceof HTMLElement && target.matches("[tabindex]:not(button):not(a)")) {
    event.preventDefault();
    target.click();
  }
}

function repeat(key: string, pressed: boolean, action: (repeated: boolean) => void, now: number, repeats = true) {
  if (!pressed) {
    delete held[key];
    return;
  }
  const since = held[key];
  if (since === undefined) {
    held[key] = repeats ? now + 380 : Number.POSITIVE_INFINITY;
    action(false);
  } else if (now >= since) {
    held[key] = now + REPEAT_MS;
    action(true);
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
    repeat(`${id}up`, button(12) || y < -0.55, (repeated) => navigate("up", repeated), now);
    repeat(`${id}down`, button(13) || y > 0.55, (repeated) => navigate("down", repeated), now);
    repeat(`${id}left`, button(14) || x < -0.55, (repeated) => navigate("left", repeated), now);
    repeat(`${id}right`, button(15) || x > 0.55, (repeated) => navigate("right", repeated), now);
    repeat(`${id}a`, button(0), () => (document.activeElement as HTMLElement | null)?.click(), now, false);
    repeat(`${id}b`, button(1), () => back(), now, false);
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
