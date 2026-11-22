/**
 * Inline icons (24×24, stroke = currentColor, rounded joins). Decorative by default
 * (aria-hidden): the surrounding control carries the accessible name. Only icons that point in
 * the reading direction mirror in RTL (`flip`).
 */
import type { ReactNode, SVGProps } from 'react';

export type IconProps = Omit<SVGProps<SVGSVGElement>, 'children'> & { flip?: boolean };

function Svg({ flip, solid, className, children, ...props }: IconProps & { solid?: boolean; children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill={solid ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className={`${flip ? 'rtl:-scale-x-100 ' : ''}shrink-0 ${className ?? 'size-5'}`}
      {...props}
    >
      {children}
    </svg>
  );
}

export function HomeIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4 10.5 12 4l8 6.5V19a1.5 1.5 0 0 1-1.5 1.5H15v-5.5h-6v5.5H5.5A1.5 1.5 0 0 1 4 19z" />
    </Svg>
  );
}

export function InboxIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4 13.5 6.4 6a1.5 1.5 0 0 1 1.43-1h8.34a1.5 1.5 0 0 1 1.43 1L20 13.5V18a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18z" />
      <path d="M4 13.5h4.5l1.2 2h4.6l1.2-2H20" />
    </Svg>
  );
}

export function CalendarIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="4" y="5.5" width="16" height="14.5" rx="2.5" />
      <path d="M8 3.5v4M16 3.5v4M4 10h16" />
      <path d="M8.5 14h.01M12 14h.01M15.5 14h.01M8.5 17h.01M12 17h.01" strokeWidth={2.4} />
    </Svg>
  );
}

export function FeatherIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M19.5 4.5c-5.5 0-11 4-12 11.5L6 19.5" />
      <path d="M7.5 16c6 .5 10.5-4 12-11.5" />
      <path d="M10 12.5h5.5" />
    </Svg>
  );
}

export function SuitcaseIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="4" y="7.5" width="16" height="12" rx="2.5" />
      <path d="M9 7.5V5.5A1.5 1.5 0 0 1 10.5 4h3A1.5 1.5 0 0 1 15 5.5v2M9 11v5M15 11v5" />
    </Svg>
  );
}

export function SettingsIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </Svg>
  );
}

export function EyeIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" />
      <circle cx="12" cy="12" r="3" />
    </Svg>
  );
}

export function EyeOffIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M9.9 5.7A9.6 9.6 0 0 1 12 5.5c6 0 9.5 6.5 9.5 6.5a17 17 0 0 1-2.6 3.4M6.4 6.9C3.9 8.6 2.5 12 2.5 12S6 18.5 12 18.5a9.3 9.3 0 0 0 4.6-1.2" />
      <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2M3.5 3.5l17 17" />
    </Svg>
  );
}

export function StarIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="m12 3.8 2.45 4.96 5.47.8-3.96 3.86.94 5.45L12 16.3l-4.9 2.57.94-5.45-3.96-3.86 5.47-.8z" />
    </Svg>
  );
}

export function MoveIcon(props: IconProps) {
  return (
    <Svg flip {...props}>
      <rect x="3.5" y="5.5" width="11" height="13" rx="2.2" />
      <path d="M3.5 9.5h11M17 12h4m0 0-2-2m2 2-2 2" />
    </Svg>
  );
}

export function CheckIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="m5 12.5 4.5 4.5L19 7.5" />
    </Svg>
  );
}

export function CheckCircleIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="m8.5 12.2 2.4 2.4 4.6-4.9" />
    </Svg>
  );
}

export function CloudOffIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M7.5 18.5H17a4 4 0 0 0 1.9-7.5M15.5 7.3A6 6 0 0 0 5.8 11 3.8 3.8 0 0 0 7 18.4" />
      <path d="m3.5 3.5 17 17" />
    </Svg>
  );
}

export function RefreshIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M19.5 12a7.5 7.5 0 0 1-13.2 4.9M4.5 12a7.5 7.5 0 0 1 13.2-4.9" />
      <path d="M18 3.5v4h-4M6 20.5v-4h4" />
    </Svg>
  );
}

export function CloseIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M6.5 6.5l11 11m0-11-11 11" />
    </Svg>
  );
}

export function ChevronLeftIcon(props: IconProps) {
  return (
    <Svg flip {...props}>
      <path d="m14.5 6-6 6 6 6" />
    </Svg>
  );
}

export function ChevronRightIcon(props: IconProps) {
  return (
    <Svg flip {...props}>
      <path d="m9.5 6 6 6-6 6" />
    </Svg>
  );
}

export function ChevronDownIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="m6 9.5 6 6 6-6" />
    </Svg>
  );
}

export function PlusIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 5v14M5 12h14" />
    </Svg>
  );
}

export function TrashIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4.5 7h15M10 4.5h4M6.5 7l.8 11.2A2 2 0 0 0 9.3 20h5.4a2 2 0 0 0 2-1.8L17.5 7" />
      <path d="M10 11v5M14 11v5" />
    </Svg>
  );
}

export function UndoIcon(props: IconProps) {
  return (
    <Svg flip {...props}>
      <path d="M9 14 4.5 9.5 9 5" />
      <path d="M4.5 9.5H14a5.5 5.5 0 0 1 0 11h-2.5" />
    </Svg>
  );
}

export function CopyIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="8.5" y="8.5" width="11" height="11" rx="2.2" />
      <path d="M15.5 8.5V6.2a1.7 1.7 0 0 0-1.7-1.7H6.2a1.7 1.7 0 0 0-1.7 1.7v7.6a1.7 1.7 0 0 0 1.7 1.7h2.3" />
    </Svg>
  );
}

export function KeyIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="8" cy="15" r="3.8" />
      <path d="m10.8 12.3 8.2-8.2M16.5 6.5l2.5 2.5M14 9l2 2" />
    </Svg>
  );
}

export function GlobeIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M3.5 12h17M12 3.5c2.3 2.4 3.4 5.2 3.4 8.5s-1.1 6.1-3.4 8.5c-2.3-2.4-3.4-5.2-3.4-8.5S9.7 5.9 12 3.5z" />
    </Svg>
  );
}

export function ClockIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 2" />
    </Svg>
  );
}

export function PinIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11z" />
      <circle cx="12" cy="10" r="2.4" />
    </Svg>
  );
}

export function SparklesIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M10 3.5 11.6 8a2 2 0 0 0 1.2 1.2l4.4 1.6-4.4 1.6a2 2 0 0 0-1.2 1.2L10 18l-1.6-4.4a2 2 0 0 0-1.2-1.2L2.8 10.8l4.4-1.6A2 2 0 0 0 8.4 8z" />
      <path d="M18 14.5v5M15.5 17h5M18.5 3.5v3M17 5h3" />
    </Svg>
  );
}

export function PlaneIcon(props: IconProps) {
  return (
    <Svg flip {...props}>
      <path d="M21 3.5 3.5 10.6l6.6 2.8 2.8 6.6z" />
      <path d="m10.1 13.4 4.6-4.6" />
    </Svg>
  );
}

export function AlertIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M10.3 4.3 2.8 17.5A2 2 0 0 0 4.5 20.5h15a2 2 0 0 0 1.7-3L13.7 4.3a2 2 0 0 0-3.4 0z" />
      <path d="M12 9.5v4M12 17h.01" />
    </Svg>
  );
}

export function PlayIcon(props: IconProps) {
  return (
    <Svg solid {...props}>
      <path d="M8 5.6v12.8a1 1 0 0 0 1.5.86l10.2-6.4a1 1 0 0 0 0-1.72L9.5 4.74A1 1 0 0 0 8 5.6z" />
    </Svg>
  );
}

export function MicIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="9" y="3.5" width="6" height="11" rx="3" />
      <path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v2.5" />
    </Svg>
  );
}

export function TextIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M5 6.5V5h14v1.5M12 5v14M9 19h6" />
    </Svg>
  );
}

export function LockIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="5" y="10.5" width="14" height="10" rx="2.5" />
      <path d="M8 10.5V8a4 4 0 0 1 8 0v2.5" />
    </Svg>
  );
}

export function LogOutIcon(props: IconProps) {
  return (
    <Svg flip {...props}>
      <path d="M14.5 4.5h3A1.5 1.5 0 0 1 19 6v12a1.5 1.5 0 0 1-1.5 1.5h-3" />
      <path d="M10 16.5 5.5 12 10 7.5M5.5 12H15" />
    </Svg>
  );
}

export function SunIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="3.8" />
      <path d="M12 2.8v1.9M12 19.3v1.9M4.2 4.2l1.3 1.3M18.5 18.5l1.3 1.3M2.8 12h1.9M19.3 12h1.9M4.2 19.8l1.3-1.3M18.5 5.5l1.3-1.3" />
    </Svg>
  );
}

export function MoonIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M19.5 14.2A8 8 0 0 1 9.8 4.5a8 8 0 1 0 9.7 9.7z" />
    </Svg>
  );
}

export function MonitorIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="3.5" y="4.5" width="17" height="11.5" rx="2" />
      <path d="M9 20h6M12 16v4" />
    </Svg>
  );
}

export function BellIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 2h-15z" />
      <path d="M10 20.5a2.2 2.2 0 0 0 4 0" />
    </Svg>
  );
}

export function PencilIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M15.2 5.3 18.7 8.8M4.5 19.5l1-4.2L16 4.8a1.8 1.8 0 0 1 2.5 0l.7.7a1.8 1.8 0 0 1 0 2.5L8.7 18.5z" />
    </Svg>
  );
}

export function InfoIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 11v5M12 8h.01" />
    </Svg>
  );
}

export function SendIcon(props: IconProps) {
  return (
    <Svg flip {...props}>
      <path d="M20.5 3.5 10 14" />
      <path d="m20.5 3.5-6.6 17-3.9-6.5-6.5-3.9z" />
    </Svg>
  );
}

export function ImageIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" />
      <circle cx="9" cy="10" r="1.8" />
      <path d="m20.5 15.5-4.5-4.5-8.5 8.5" />
    </Svg>
  );
}

export function VideoIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="3" y="6" width="13" height="12" rx="2.5" />
      <path d="m16 10.5 5-3v9l-5-3z" />
    </Svg>
  );
}

export function HeartIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 19.5s-7.5-4.4-7.5-10A4.3 4.3 0 0 1 12 7a4.3 4.3 0 0 1 7.5 2.5c0 5.6-7.5 10-7.5 10z" />
    </Svg>
  );
}

export function CompassIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="m15.5 8.5-2.2 4.8-4.8 2.2 2.2-4.8z" />
    </Svg>
  );
}

export function LinkIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1" />
      <path d="M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1" />
    </Svg>
  );
}

export function BookIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4.5 5.5A1.5 1.5 0 0 1 6 4h12.5v14H6a1.5 1.5 0 0 0-1.5 1.5z" />
      <path d="M4.5 19.5A1.5 1.5 0 0 0 6 21h12.5v-3M9 8h6" />
    </Svg>
  );
}

export function WifiIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M2.5 9a14 14 0 0 1 19 0M5.5 12.5a9.5 9.5 0 0 1 13 0M8.5 16a5 5 0 0 1 7 0" />
      <path d="M12 19.5h.01" strokeWidth={2.6} />
    </Svg>
  );
}

/** iOS "Share" (a box with an arrow up). */
export function ShareIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 3.5v11M8 7.5l4-4 4 4" />
      <path d="M8.5 10.5h-2a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-6a2 2 0 0 0-2-2h-2" />
    </Svg>
  );
}

/** Add to the home screen (a phone with a plus). */
export function InstallIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="6.5" y="2.5" width="11" height="19" rx="2.5" />
      <path d="M12 9v6M9 12h6" />
    </Svg>
  );
}

/** People (two heads): followers. */
export function PeopleIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="9" cy="8.5" r="3.2" />
      <path d="M3.5 19.5c.6-3.3 2.8-5.2 5.5-5.2s4.9 1.9 5.5 5.2" />
      <path d="M15.5 5.6a3 3 0 0 1 0 5.8M17.5 14.6c1.6.6 2.7 2.2 3 4.9" />
    </Svg>
  );
}

/** Four rounded tiles: "more" (every area of the admin, phone tab bar). */
export function MoreIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="4.5" y="4.5" width="6" height="6" rx="1.8" />
      <rect x="13.5" y="4.5" width="6" height="6" rx="1.8" />
      <rect x="4.5" y="13.5" width="6" height="6" rx="1.8" />
      <rect x="13.5" y="13.5" width="6" height="6" rx="1.8" />
    </Svg>
  );
}

/** A soft shield: who can see the journey. */
export function ShieldIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 3.5 5 6.2v5.3c0 4.3 2.9 7.7 7 9 4.1-1.3 7-4.7 7-9V6.2z" />
      <path d="m9 12 2.2 2.2L15.3 10" />
    </Svg>
  );
}

/** A phone: one device of a person. */
export function PhoneIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="7" y="2.5" width="10" height="19" rx="2.5" />
      <path d="M11 18h2" />
    </Svg>
  );
}

/** A tablet (iPad). */
export function TabletIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="4.5" y="2.5" width="15" height="19" rx="2.5" />
      <path d="M11 18h2" />
    </Svg>
  );
}

/** A laptop (Mac, Windows, Linux). */
export function LaptopIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="4.5" y="5" width="15" height="10.5" rx="1.5" />
      <path d="M2.5 19h19" />
    </Svg>
  );
}

/** A device of unknown kind: a screen and a phone. */
export function DevicesIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="2.5" y="4.5" width="13" height="9.5" rx="1.5" />
      <path d="M6 18.5h6M9 14v4.5" />
      <rect x="16" y="8.5" width="5.5" height="11" rx="1.5" />
    </Svg>
  );
}

/** An open padlock: unlock. */
export function UnlockIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="5" y="10.5" width="14" height="10" rx="2.5" />
      <path d="M8 10.5V8a4 4 0 0 1 7.6-1.7" />
    </Svg>
  );
}
