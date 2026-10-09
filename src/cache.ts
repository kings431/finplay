import { useEffect, useRef, useState } from "react";

const store = new Map<string, { value: unknown; at: number }>();
const listeners = new Map<string, Set<() => void>>();
/** Every library filter and detail page adds an entry; keep the most recent. */
const MAX_ENTRIES = 150;
/** Entries kept across launches so the first screen draws before the server answers. */
const DISK_PREFIX = "finplay.cache.";

function fromDisk(key: string) {
  if (store.has(key)) return;
  try {
    const raw = localStorage.getItem(DISK_PREFIX + key);
    if (raw) store.set(key, JSON.parse(raw) as { value: unknown; at: number });
  } catch {
    localStorage.removeItem(DISK_PREFIX + key);
  }
}

function toDisk(key: string) {
  try {
    localStorage.setItem(DISK_PREFIX + key, JSON.stringify(store.get(key)));
  } catch {
    // Over quota: the in-memory copy still works for this session.
  }
}

/** Map order is insertion order, so re-inserting marks an entry most recently used. */
function touch(key: string) {
  const entry = store.get(key);
  if (entry) {
    store.delete(key);
    store.set(key, entry);
  }
  return entry;
}

function remember(key: string, value: unknown) {
  store.delete(key);
  store.set(key, { value, at: Date.now() });
  for (const old of store.keys()) {
    if (store.size <= MAX_ENTRIES) break;
    if (!listeners.has(old)) store.delete(old);
  }
}

function notify(prefix: string) {
  for (const [key, set] of listeners) {
    if (key.startsWith(prefix)) {
      for (const ping of set) ping();
    }
  }
}

export function clearCache() {
  store.clear();
  for (const key of Object.keys(localStorage)) if (key.startsWith(DISK_PREFIX)) localStorage.removeItem(key);
  notify("");
}

export function invalidate(prefix: string) {
  for (const key of store.keys()) if (key.startsWith(prefix)) store.delete(key);
  notify(prefix);
}

/** Like `invalidate`, but keeps showing the old value while the refetch runs. */
export function markStale(prefix: string) {
  for (const [key, entry] of store) if (key.startsWith(prefix)) entry.at = 0;
  notify(prefix);
}

/**
 * Stale-while-revalidate: returns the last value for `key` immediately and
 * refreshes it in the background, so revisiting a page never starts empty.
 * With `maxAge`, a cached value younger than that many milliseconds is kept as is.
 * `invalidate` drops matching entries and reloads any mounted hooks.
 */
export function useCached<T>(key: string | null, load: () => Promise<T>, options?: { maxAge?: number; persist?: boolean }) {
  const persist = options?.persist === true;
  if (key && persist) fromDisk(key);
  const [data, setData] = useState<T | undefined>(() => (key ? (store.get(key)?.value as T | undefined) : undefined));
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(() => !key || !store.has(key));
  const [tick, setTick] = useState(0);
  const loadRef = useRef(load);
  loadRef.current = load;
  const maxAge = options?.maxAge ?? 0;

  useEffect(() => {
    if (!key) return;
    let set = listeners.get(key);
    if (!set) {
      set = new Set();
      listeners.set(key, set);
    }
    const ping = () => setTick((value) => value + 1);
    set.add(ping);
    return () => {
      set!.delete(ping);
      if (set!.size === 0) listeners.delete(key);
    };
  }, [key]);

  useEffect(() => {
    if (!key) return;
    let cancel = false;
    const entry = touch(key);
    const cached = entry?.value as T | undefined;
    setData(cached);
    setError("");
    if (entry && Date.now() - entry.at < maxAge) {
      setLoading(false);
      return;
    }
    setLoading(cached === undefined);
    loadRef
      .current()
      .then((value) => {
        remember(key, value);
        if (persist) toDisk(key);
        if (!cancel) setData(value);
      })
      .catch((err: unknown) => {
        if (!cancel && cached === undefined) setError(err instanceof Error ? err.message : "Could not load this.");
      })
      .finally(() => {
        if (!cancel) setLoading(false);
      });
    return () => {
      cancel = true;
    };
  }, [key, maxAge, persist, tick]);

  return { data, error, loading };
}
