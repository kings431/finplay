import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";

const GAP = 8;
const MARGIN = 12;

/** A menu rendered at the document root so clipped containers can't cut it off. */
export function Popover({
  anchorRef,
  align = "start",
  side = "below",
  onClose,
  children,
}: {
  anchorRef: RefObject<HTMLElement | null>;
  align?: "start" | "end";
  /** `right` opens beside the anchor, bottom-aligned, for sidebar buttons. */
  side?: "below" | "right";
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<CSSProperties>({ visibility: "hidden", left: 0, top: 0 });

  useLayoutEffect(() => {
    const pop = ref.current;
    if (!pop) return;
    function place() {
      const anchor = anchorRef.current?.getBoundingClientRect();
      if (!anchor || !pop) return;
      const width = pop.offsetWidth;
      const height = pop.offsetHeight;
      if (side === "right") {
        const left = Math.min(anchor.right + GAP, window.innerWidth - width - MARGIN);
        const top = Math.max(MARGIN, Math.min(anchor.bottom - height, window.innerHeight - height - MARGIN));
        setStyle({ left, top });
        return;
      }
      let left = align === "end" ? anchor.right - width : anchor.left;
      left = Math.max(MARGIN, Math.min(left, window.innerWidth - width - MARGIN));
      let top = anchor.bottom + GAP;
      if (top + height > window.innerHeight - MARGIN && anchor.top - GAP - height >= MARGIN) top = anchor.top - GAP - height;
      top = Math.max(MARGIN, Math.min(top, window.innerHeight - height - MARGIN));
      setStyle({ left, top });
    }
    place();
    const observer = new ResizeObserver(place);
    observer.observe(pop);
    window.addEventListener("resize", place);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", place);
    };
  }, [anchorRef, align, side]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return createPortal(
    <>
      <div className="menu-scrim" onClick={onClose} onWheel={onClose} />
      <div ref={ref} className="menu-pop" style={style} role="menu">
        {children}
      </div>
    </>,
    document.body,
  );
}
