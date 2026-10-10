/**
 * An on-screen readout of how quickly the app answers the remote, for
 * reporting numbers from a TV that can't be profiled. Off by default
 * (Settings > Show performance stats). It measures only around key presses,
 * so it doesn't keep the TV drawing frames while nothing happens.
 */

import { scrollsInstantly } from "./couch";

/** How long after a press frames are counted. */
const WATCH_MS = 1000;
const KEEP = 20;

let box: HTMLDivElement | null = null;
let latencies: number[] = [];
let delays: number[] = [];
let longTasks: number[] = [];
let observer: PerformanceObserver | null = null;
let watchUntil = 0;
let watching = false;
let motion = { frames: 0, start: 0, last: 0, worst: 0 };
let fps = "";
let pending = 0;

function remember(list: number[], value: number) {
  list.push(value);
  if (list.length > KEEP) list.shift();
}

function render() {
  pending = 0;
  if (!box) return;
  const now = performance.now();
  longTasks = longTasks.filter((at) => now - at < 10_000);
  const last = latencies[latencies.length - 1];
  const sorted = [...latencies].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const memory = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory;
  const lines = [
    last === undefined ? "key → frame: press a key" : `key → frame ${Math.round(last)} ms (median ${Math.round(median)}, worst ${Math.round(sorted[sorted.length - 1])})`,
    delays.length ? `input waited ${Math.round(delays[delays.length - 1])} ms` : "",
    fps,
    `long tasks ${longTasks.length} in 10 s`,
    `${document.getElementsByTagName("*").length} elements${memory ? ` · JS ${Math.round(memory.usedJSHeapSize / 1e6)} MB` : ""} · scroll ${scrollsInstantly() ? "jumps" : "glides"}`,
  ];
  box.textContent = lines.filter(Boolean).join("\n");
}

function scheduleRender() {
  if (!pending) pending = window.setTimeout(render, 250);
}

function frame(now: number) {
  if (!box) return;
  if (motion.last) {
    motion.frames++;
    motion.worst = Math.max(motion.worst, now - motion.last);
  }
  motion.last = now;
  if (now < watchUntil) {
    requestAnimationFrame(frame);
    return;
  }
  watching = false;
  const span = now - motion.start;
  if (motion.frames > 1 && span > 0) fps = `frames after a press: ${Math.round((motion.frames * 1000) / span)} fps, slowest ${Math.round(motion.worst)} ms`;
  scheduleRender();
}

function onKey(event: KeyboardEvent) {
  const start = performance.now();
  // Chromium stamps the event when the remote's signal arrived.
  const pressed = event.timeStamp > 0 && event.timeStamp <= start ? event.timeStamp : start;
  remember(delays, start - pressed);
  // The frame showing the press is drawn after this animation frame callback;
  // a task queued from it runs once that frame's work is done.
  requestAnimationFrame(() =>
    window.setTimeout(() => {
      remember(latencies, performance.now() - pressed);
      scheduleRender();
    }),
  );
  watchUntil = start + WATCH_MS;
  if (!watching) {
    watching = true;
    motion = { frames: 0, start, last: 0, worst: 0 };
    requestAnimationFrame(frame);
  }
}

export function applyPerfStats(on: boolean) {
  if (!on) {
    window.removeEventListener("keydown", onKey, true);
    observer?.disconnect();
    observer = null;
    box?.remove();
    box = null;
    return;
  }
  if (box) return;
  box = document.createElement("div");
  box.className = "perf-stats";
  box.setAttribute("aria-hidden", "true");
  document.body.appendChild(box);
  latencies = [];
  delays = [];
  longTasks = [];
  fps = "";
  window.addEventListener("keydown", onKey, true);
  // The page is still loading now; show what it settles at.
  window.setTimeout(scheduleRender, 4000);
  try {
    observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) longTasks.push(entry.startTime);
      scheduleRender();
    });
    observer.observe({ entryTypes: ["longtask"] });
  } catch {
    // Not every engine reports long tasks.
  }
  render();
}
