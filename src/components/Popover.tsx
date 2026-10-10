import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { tv } from "../tv";

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
      // The TV's zoom leaves innerWidth in unzoomed pixels; the page's own box is in the same units as the anchor.
      const view = tv ? document.body.getBoundingClientRect() : { width: window.innerWidth, height: window.innerHeight };
      if (side === "right") {
        const left = Math.min(anchor.right + GAP, view.width - width - MARGIN);
        const top = Math.max(MARGIN, Math.min(anchor.bottom - height, view.height - height - MARGIN));
        setStyle({ left, top });
        return;
      }
      let left = align === "end" ? anchor.right - width : anchor.left;
      left = Math.max(MARGIN, Math.min(left, view.width - width - MARGIN));
      let top = anchor.bottom + GAP;
      if (top + height > view.height - MARGIN && anchor.top - GAP - height >= MARGIN) top = anchor.top - GAP - height;
      top = Math.max(MARGIN, Math.min(top, view.height - height - MARGIN));
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
