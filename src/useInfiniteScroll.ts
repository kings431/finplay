import { useEffect, useRef } from "react";

/**
 * Calls `onLoad` when the returned sentinel gets near the bottom of the scrolling `.main`
 * area. `key` should change whenever new items arrive so a sentinel that is still on screen
 * after a short page triggers the next load.
 */
export function useInfiniteScroll(onLoad: () => void, enabled: boolean, key: unknown) {
  const ref = useRef<HTMLDivElement>(null);
  const load = useRef(onLoad);
  load.current = onLoad;

  useEffect(() => {
    const sentinel = ref.current;
    if (!sentinel || !enabled) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) load.current();
      },
      { root: sentinel.closest(".main"), rootMargin: "0px 0px 900px 0px" },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [enabled, key]);

  return ref;
}
