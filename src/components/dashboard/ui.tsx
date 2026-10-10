import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

/** Loads now and every `ms` while the window is visible; `ms` may change between renders. */
export function usePoll<T>(load: () => Promise<T>, ms: number, key: string) {
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const loadRef = useRef(load);
  loadRef.current = load;
  const runRef = useRef(0);

  const reload = useCallback(async () => {
    const run = ++runRef.current;
    try {
      const next = await loadRef.current();
      if (run !== runRef.current) return;
      setData(next);
      setError("");
    } catch (err) {
      if (run !== runRef.current) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (run === runRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    setLoading(true);
    void reload();
  }, [key, reload]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (!document.hidden) void reload();
    }, ms);
    return () => window.clearInterval(timer);
  }, [ms, key, reload]);

  return { data, error, loading, reload };
}

/** Re-renders every second, for clocks that run between polls. */
export function useTicker(enabled = true) {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    const timer = window.setInterval(() => setTick((value) => value + 1), 1000);
    return () => window.clearInterval(timer);
  }, [enabled]);
}

export type ConfirmRequest = { title: string; body: ReactNode; action: string; danger?: boolean; run: () => Promise<void> };

/** Asks before anything that interrupts people or takes the server down. */
export function useConfirm() {
  const [request, setRequest] = useState<ConfirmRequest | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const close = () => {
    if (busy) return;
    setRequest(null);
    setError("");
  };

  const dialog = request ? (
    <div className="sheet-backdrop" onClick={close}>
      <div className="resume-card dash-confirm" role="dialog" aria-modal="true" aria-label={request.title} onClick={(event) => event.stopPropagation()}>
        <h2>{request.title}</h2>
        <div className="dash-confirm-body">{request.body}</div>
        {error ? <p className="error-text">{error}</p> : null}
        <div className="dash-confirm-actions">
          <button className="btn-ghost" onClick={close} disabled={busy} autoFocus={request.danger}>
            Cancel
          </button>
          <button
            className={request.danger ? "btn-primary dash-danger" : "btn-primary"}
            disabled={busy}
            autoFocus={!request.danger}
            onClick={() => {
              setBusy(true);
              setError("");
              request
                .run()
                .then(() => setRequest(null))
                .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
                .finally(() => setBusy(false));
            }}
          >
            {busy ? "Working…" : request.action}
          </button>
        </div>
      </div>
    </div>
  ) : null;

  return { ask: setRequest, dialog };
}

export function errorText(err: unknown) {
  return err instanceof Error ? err.message : String(err);
}

export function ago(stamp?: string) {
  if (!stamp) return "";
  const when = new Date(stamp);
  const seconds = (Date.now() - when.getTime()) / 1000;
  if (!Number.isFinite(seconds)) return "";
  if (seconds < 0 || when.getFullYear() < 2000) return "never";
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h ago`;
  if (seconds < 86400 * 7) return `${Math.round(seconds / 86400)}d ago`;
  return when.toLocaleDateString(undefined, { month: "short", day: "numeric", year: when.getFullYear() === new Date().getFullYear() ? undefined : "numeric" });
}

export function fullDate(stamp?: string) {
  if (!stamp) return "";
  const when = new Date(stamp);
  return Number.isFinite(when.getTime()) ? when.toLocaleString() : "";
}

export function bytes(size?: number) {
  if (size === undefined || !Number.isFinite(size)) return "";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let value = size;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 100 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

export function clock(seconds: number) {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}

export function spanBetween(start?: string, end?: string) {
  if (!start || !end) return "";
  const seconds = Math.max(0, (new Date(end).getTime() - new Date(start).getTime()) / 1000);
  if (!Number.isFinite(seconds)) return "";
  if (seconds < 60) return `${Math.max(1, Math.round(seconds))}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}h ${Math.round((seconds % 3600) / 60)}m`;
}

export function spaced(label: string) {
  return label.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, (first) => first.toUpperCase());
}

type IconProps = { size?: number };

function svg(size = 18) {
  return {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.8,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
  };
}

export function IconPrev({ size }: IconProps) {
  return (
    <svg {...svg(size)}>
      <path d="M6 5v14" />
      <path d="M19 5.5v13L9 12z" fill="currentColor" />
    </svg>
  );
}

export function IconNext({ size }: IconProps) {
  return (
    <svg {...svg(size)}>
      <path d="M18 5v14" />
      <path d="M5 5.5v13L15 12z" fill="currentColor" />
    </svg>
  );
}

function speaker() {
  return <path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z" fill="currentColor" />;
}

export function IconVolumeDown({ size }: IconProps) {
  return (
    <svg {...svg(size)}>
      {speaker()}
      <path d="M15.5 9.5a3.5 3.5 0 0 1 0 5" />
    </svg>
  );
}

export function IconVolumeUp({ size }: IconProps) {
  return (
    <svg {...svg(size)}>
      {speaker()}
      <path d="M15.5 9.5a3.5 3.5 0 0 1 0 5M18 7a7 7 0 0 1 0 10" />
    </svg>
  );
}

export function IconMute({ size }: IconProps) {
  return (
    <svg {...svg(size)}>
      {speaker()}
      <path d="M16 9.5l5 5M21 9.5l-5 5" />
    </svg>
  );
}

export function IconMessage({ size }: IconProps) {
  return (
    <svg {...svg(size)}>
      <path d="M4.5 5.5h15a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H10l-4.5 3.5v-3.5h-1a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1z" />
    </svg>
  );
}

export function IconRefresh({ size }: IconProps) {
  return (
    <svg {...svg(size)}>
      <path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3" />
      <path d="M19.5 4.5v4h-4" />
    </svg>
  );
}

export function IconServer({ size }: IconProps) {
  return (
    <svg {...svg(size)}>
      <rect x="4" y="4.5" width="16" height="6" rx="1.6" />
      <rect x="4" y="13.5" width="16" height="6" rx="1.6" />
      <path d="M8 7.5h.01M8 16.5h.01" strokeWidth={2.6} />
    </svg>
  );
}
