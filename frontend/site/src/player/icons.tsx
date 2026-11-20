/**
 * Tiny inline icons of the player (24-unit grid, round strokes, currentColor). Decorative:
 * every button that uses one carries its own accessible name.
 */
import type { SVGProps } from 'react';

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function Svg({ size = 24, children, ...rest }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {children}
    </svg>
  );
}

export function PlayIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.4-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5Z" fill="currentColor" />
    </Svg>
  );
}

export function PauseIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <rect x="6.5" y="5" width="3.5" height="14" rx="1.2" fill="currentColor" stroke="none" />
      <rect x="14" y="5" width="3.5" height="14" rx="1.2" fill="currentColor" stroke="none" />
    </Svg>
  );
}

export function CloseIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M6 6l12 12M18 6 6 18" />
    </Svg>
  );
}

/** Points to the inline end; mirrored in RTL by the caller (rtl:-scale-x-100). */
export function ChevronIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="m9.5 5.5 6.5 6.5-6.5 6.5" />
    </Svg>
  );
}

export function ChevronUpIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="m5.5 14.5 6.5-6.5 6.5 6.5" />
    </Svg>
  );
}

export function SoundOffIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M4 9.5h3.2L12 5.5v13l-4.8-4H4z" fill="currentColor" strokeWidth={1.5} />
      <path d="m16 9.5 5 5m0-5-5 5" />
    </Svg>
  );
}

export function SoundOnIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M4 9.5h3.2L12 5.5v13l-4.8-4H4z" fill="currentColor" strokeWidth={1.5} />
      <path d="M15.5 9a4.2 4.2 0 0 1 0 6M18.2 6.5a7.8 7.8 0 0 1 0 11" />
    </Svg>
  );
}

export function MoreIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <circle cx="5.5" cy="12" r="1.6" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none" />
      <circle cx="18.5" cy="12" r="1.6" fill="currentColor" stroke="none" />
    </Svg>
  );
}

export function LeafIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M5 19c0-8 5-13 14-14-.5 9-5.5 14-13 14" />
      <path d="M5 19c3-4 6-6.5 9.5-8.5" />
    </Svg>
  );
}

export function ReplayIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3" />
      <path d="M4.5 4.5v4h4" />
    </Svg>
  );
}

export function BookIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M12 6.5C10.2 5 7.6 4.5 4 4.8v13c3.6-.3 6.2.2 8 1.7 1.8-1.5 4.4-2 8-1.7v-13c-3.6-.3-6.2.2-8 1.7Z" />
      <path d="M12 6.5v13" />
    </Svg>
  );
}

export function Spinner({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 48 48" className={className} aria-hidden="true" focusable="false">
      <circle cx="24" cy="24" r="19" fill="none" stroke="currentColor" strokeOpacity="0.25" strokeWidth="4" />
      <path d="M24 5a19 19 0 0 1 19 19" fill="none" stroke="currentColor" strokeWidth="4" strokeLinecap="round">
        <animateTransform
          attributeName="transform"
          type="rotate"
          from="0 24 24"
          to="360 24 24"
          dur="0.9s"
          repeatCount="indefinite"
        />
      </path>
    </svg>
  );
}
