import markUrl from "./assets/finplay-mark.png";
import wordmarkUrl from "./assets/finplay-wordmark.png";
import wordmarkLightUrl from "./assets/finplay-wordmark-light.png";

type IconProps = { size?: number };

function base(size = 22) {
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

export function IconCast({ size }: IconProps) {
  return (
    <svg {...base(size)}>
      <path d="M3.5 9V6.5a2 2 0 0 1 2-2h13a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H14" />
      <path d="M3.5 12.5a7 7 0 0 1 7 7M3.5 16a3.5 3.5 0 0 1 3.5 3.5" />
      <path d="M3.5 19.5h.01" strokeWidth={2.6} />
    </svg>
  );
}

export function IconPlaylist({ size }: IconProps) {
  return (
    <svg {...base(size)}>
      <path d="M4 6.5h11M4 11.5h11M4 16.5h6.5" />
      <path d="M15.5 14.2v5.3l4.5-2.65z" fill="currentColor" />
    </svg>
  );
}

export function IconPlus({ size }: IconProps) {
  return (
    <svg {...base(size)}>
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

export function IconUp({ size }: IconProps) {
  return (
    <svg {...base(size)}>
      <path d="m6 14 6-6 6 6" />
    </svg>
  );
}

export function IconDown({ size }: IconProps) {
  return (
    <svg {...base(size)}>
      <path d="m6 10 6 6 6-6" />
    </svg>
  );
}

export function IconStop({ size }: IconProps) {
  return (
    <svg {...base(size)}>
      <rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function IconHome({ size }: IconProps) {
  return (
    <svg {...base(size)}>
      <path d="M4 10.5 12 4l8 6.5V20a1 1 0 0 1-1 1h-5v-6H10v6H5a1 1 0 0 1-1-1z" />
    </svg>
  );
}

export function IconFilm({ size }: IconProps) {
  return (
    <svg {...base(size)}>
      <rect x="3.5" y="5" width="17" height="14" rx="2" />
      <path d="M8 5v14M16 5v14M3.5 9.5h4.5M3.5 14.5h4.5M16 9.5h4.5M16 14.5h4.5" />
    </svg>
  );
}

export function IconTv({ size }: IconProps) {
  return (
    <svg {...base(size)}>
      <rect x="3.5" y="6" width="17" height="12" rx="2" />
      <path d="M8 20h8M12 6 9.5 3.5M12 6l2.5-2.5" />
    </svg>
  );
}

export function IconLive({ size }: IconProps) {
  return (
    <svg {...base(size)}>
      <rect x="3" y="7" width="18" height="13" rx="2" />
      <path d="m8 3 4 4 4-4" />
      <circle cx="12" cy="13.5" r="2" />
    </svg>
  );
}

export function IconUsers({ size }: IconProps) {
  return (
    <svg {...base(size)}>
      <circle cx="9" cy="8.5" r="3.2" />
      <path d="M3 19.5c.6-3.3 3-5.2 6-5.2s5.4 1.9 6 5.2" />
      <path d="M15.5 5.6a3 3 0 0 1 0 5.8M17.5 14.6c1.9.6 3.1 2.3 3.5 4.9" />
    </svg>
  );
}

export function IconGrid({ size }: IconProps) {
  return (
    <svg {...base(size)}>
      <rect x="4" y="4" width="6.5" height="6.5" rx="1.4" />
      <rect x="13.5" y="4" width="6.5" height="6.5" rx="1.4" />
      <rect x="4" y="13.5" width="6.5" height="6.5" rx="1.4" />
      <rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.4" />
    </svg>
  );
}

export function IconChart({ size }: IconProps) {
  return (
    <svg {...base(size)}>
      <path d="M4.5 19.5h15M7.5 16v-4.5M12 16V7.5M16.5 16v-6.5" />
    </svg>
  );
}

export function IconDownload({ size }: IconProps) {
  return (
    <svg {...base(size)}>
      <path d="M12 4v11M7.5 10.5 12 15l4.5-4.5M5 19.5h14" />
    </svg>
  );
}

export function IconDownloaded({ size }: IconProps) {
  return (
    <svg {...base(size)}>
      <path d="M5 19.5h14M7.5 11 11 14.5 17 7.5" />
    </svg>
  );
}

export function IconCompass({ size }: IconProps) {
  return (
    <svg {...base(size)}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="m15.5 8.5-2 5-5 2 2-5z" />
    </svg>
  );
}

export function IconSearch({ size }: IconProps) {
  return (
    <svg {...base(size)}>
      <circle cx="11" cy="11" r="6.5" />
      <path d="m16 16 4 4" />
    </svg>
  );
}

export function IconSettings({ size }: IconProps) {
  return (
    <svg {...base(size)}>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 3.5v2.2M12 18.3v2.2M4.8 6.8l1.6 1.6M17.6 15.6l1.6 1.6M3.5 12h2.2M18.3 12h2.2M4.8 17.2l1.6-1.6M17.6 8.4l1.6-1.6" />
    </svg>
  );
}

export function IconPlay({ size }: IconProps) {
  return (
    <svg {...base(size)} fill="currentColor" stroke="none">
      <path d="M8 5.8v12.4c0 .7.8 1.1 1.4.7l9.2-6.2a.8.8 0 0 0 0-1.4L9.4 5.1A.8.8 0 0 0 8 5.8z" />
    </svg>
  );
}

export function IconPause({ size }: IconProps) {
  return (
    <svg {...base(size)} fill="currentColor" stroke="none">
      <rect x="6.5" y="5" width="3.4" height="14" rx="1" />
      <rect x="14.1" y="5" width="3.4" height="14" rx="1" />
    </svg>
  );
}

export function IconBack({ size }: IconProps) {
  return (
    <svg {...base(size)}>
      <path d="M15 5 8 12l7 7" />
    </svg>
  );
}

export function IconInfo({ size }: IconProps) {
  return (
    <svg {...base(size)}>
      <circle cx="12" cy="12" r="8" />
      <path d="M12 11v5M12 8h.01" />
    </svg>
  );
}

export function IconHeart({ size, filled }: IconProps & { filled?: boolean }) {
  return (
    <svg {...base(size)} fill={filled ? "currentColor" : "none"}>
      <path d="M12 20s-7.5-4.6-7.5-10.2A4.3 4.3 0 0 1 12 7.4a4.3 4.3 0 0 1 7.5 2.4C19.5 15.4 12 20 12 20z" />
    </svg>
  );
}

export function IconCheck({ size }: IconProps) {
  return (
    <svg {...base(size)} strokeWidth={2.2}>
      <path d="m5.5 12.5 4 4 9-9.5" />
    </svg>
  );
}

export function IconClose({ size }: IconProps) {
  return (
    <svg {...base(size)}>
      <path d="m7 7 10 10M17 7 7 17" />
    </svg>
  );
}

export function Mark({ size = 36 }: { size?: number }) {
  return <img className="mark" src={markUrl} width={size} height={size} alt="" draggable={false} />;
}

/** The "finplay" lettering; "fin" is white on dark themes and near-black on light. */
export function Wordmark({ height = 40 }: { height?: number }) {
  return (
    <span className="wordmark" role="img" aria-label="Finplay">
      <img className="wordmark-dark" src={wordmarkUrl} height={height} alt="" draggable={false} />
      <img className="wordmark-light" src={wordmarkLightUrl} height={height} alt="" draggable={false} />
    </span>
  );
}
