import { useEffect, useRef, useState } from "react";

const store = new Map<string, { value: unknown; at: number }>();

export function clearCache() {
  store.clear();
}

export function invalidate(prefix: string) {
  for (const key of store.keys()) if (key.startsWith(prefix)) store.delete(key);
}

/**
 * Stale-while-revalidate: returns the last value for `key` immediately and
 * refreshes it in the background, so revisiting a page never starts empty.
 * With `maxAge`, a cached value younger than that many milliseconds is kept as is.
 */
export function useCached<T>(key: string | null, load: () => Promise<T>, options?: { maxAge?: number }) {
  const [data, setData] = useState<T | undefined>(() => (key ? (store.get(key)?.value as T | undefined) : undefined));
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(() => !key || !store.has(key));
  const loadRef = useRef(load);
  loadRef.current = load;
  const maxAge = options?.maxAge ?? 0;

  useEffect(() => {
    if (!key) return;
    let cancel = false;
    const entry = store.get(key);
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
        store.set(key, { value, at: Date.now() });
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
  }, [key, maxAge]);

  return { data, error, loading };
}
