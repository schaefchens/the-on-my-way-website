/**
 * Line icons for the app (react-native-svg): the admin's set (frontend/admin/src/components/icons.tsx:
 * 24 grid, 1.8 stroke, rounded joins), ported as data, plus a few camera glyphs in the same style.
 * Decorative: the surrounding control carries the accessible name. Icons that point in the reading
 * direction mirror in RTL (`flip`).
 */
import { I18nManager } from 'react-native';
import Svg, { Circle, Path, Rect } from 'react-native-svg';

type Shape =
  | ['path', { d: string; strokeWidth?: number }]
  | ['circle', { cx: number; cy: number; r: number }]
  | ['rect', { x: number; y: number; width: number; height: number; rx?: number }];

interface IconDef {
  flip: boolean;
  solid: boolean;
  shapes: Shape[];
}

const ICONS = {
  Inbox: {
    flip: false,
    solid: false,
    shapes: [
      [
        'path',
        {
          d: 'M4 13.5 6.4 6a1.5 1.5 0 0 1 1.43-1h8.34a1.5 1.5 0 0 1 1.43 1L20 13.5V18a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18z',
        },
      ],
      ['path', { d: 'M4 13.5h4.5l1.2 2h4.6l1.2-2H20' }],
    ],
  },
  Calendar: {
    flip: false,
    solid: false,
    shapes: [
      ['rect', { x: 4, y: 5.5, width: 16, height: 14.5, rx: 2.5 }],
      ['path', { d: 'M8 3.5v4M16 3.5v4M4 10h16' }],
      ['path', { d: 'M8.5 14h.01M12 14h.01M15.5 14h.01M8.5 17h.01M12 17h.01', strokeWidth: 2.4 }],
    ],
  },
  Settings: {
    flip: false,
    solid: false,
    shapes: [
      ['circle', { cx: 12, cy: 12, r: 3 }],
      [
        'path',
        {
          d: 'M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z',
        },
      ],
    ],
  },
  Eye: {
    flip: false,
    solid: false,
    shapes: [
      ['path', { d: 'M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z' }],
      ['circle', { cx: 12, cy: 12, r: 3 }],
    ],
  },
  EyeOff: {
    flip: false,
    solid: false,
    shapes: [
      [
        'path',
        {
          d: 'M9.9 5.7A9.6 9.6 0 0 1 12 5.5c6 0 9.5 6.5 9.5 6.5a17 17 0 0 1-2.6 3.4M6.4 6.9C3.9 8.6 2.5 12 2.5 12S6 18.5 12 18.5a9.3 9.3 0 0 0 4.6-1.2',
        },
      ],
      ['path', { d: 'M9.9 9.9a3 3 0 0 0 4.2 4.2M3.5 3.5l17 17' }],
    ],
  },
  Check: { flip: false, solid: false, shapes: [['path', { d: 'm5 12.5 4.5 4.5L19 7.5' }]] },
  CheckCircle: {
    flip: false,
    solid: false,
    shapes: [
      ['circle', { cx: 12, cy: 12, r: 8.5 }],
      ['path', { d: 'm8.5 12.2 2.4 2.4 4.6-4.9' }],
    ],
  },
  CloudOff: {
    flip: false,
    solid: false,
    shapes: [
      ['path', { d: 'M7.5 18.5H17a4 4 0 0 0 1.9-7.5M15.5 7.3A6 6 0 0 0 5.8 11 3.8 3.8 0 0 0 7 18.4' }],
      ['path', { d: 'm3.5 3.5 17 17' }],
    ],
  },
  Refresh: {
    flip: false,
    solid: false,
    shapes: [
      ['path', { d: 'M19.5 12a7.5 7.5 0 0 1-13.2 4.9M4.5 12a7.5 7.5 0 0 1 13.2-4.9' }],
      ['path', { d: 'M18 3.5v4h-4M6 20.5v-4h4' }],
    ],
  },
  Close: { flip: false, solid: false, shapes: [['path', { d: 'M6.5 6.5l11 11m0-11-11 11' }]] },
  ChevronLeft: { flip: true, solid: false, shapes: [['path', { d: 'm14.5 6-6 6 6 6' }]] },
  ChevronRight: { flip: true, solid: false, shapes: [['path', { d: 'm9.5 6 6 6-6 6' }]] },
  ChevronDown: { flip: false, solid: false, shapes: [['path', { d: 'm6 9.5 6 6 6-6' }]] },
  Plus: { flip: false, solid: false, shapes: [['path', { d: 'M12 5v14M5 12h14' }]] },
  Trash: {
    flip: false,
    solid: false,
    shapes: [
      ['path', { d: 'M4.5 7h15M10 4.5h4M6.5 7l.8 11.2A2 2 0 0 0 9.3 20h5.4a2 2 0 0 0 2-1.8L17.5 7' }],
      ['path', { d: 'M10 11v5M14 11v5' }],
    ],
  },
  Undo: {
    flip: true,
    solid: false,
    shapes: [
      ['path', { d: 'M9 14 4.5 9.5 9 5' }],
      ['path', { d: 'M4.5 9.5H14a5.5 5.5 0 0 1 0 11h-2.5' }],
    ],
  },
  Key: {
    flip: false,
    solid: false,
    shapes: [
      ['circle', { cx: 8, cy: 15, r: 3.8 }],
      ['path', { d: 'm10.8 12.3 8.2-8.2M16.5 6.5l2.5 2.5M14 9l2 2' }],
    ],
  },
  Globe: {
    flip: false,
    solid: false,
    shapes: [
      ['circle', { cx: 12, cy: 12, r: 8.5 }],
      [
        'path',
        { d: 'M3.5 12h17M12 3.5c2.3 2.4 3.4 5.2 3.4 8.5s-1.1 6.1-3.4 8.5c-2.3-2.4-3.4-5.2-3.4-8.5S9.7 5.9 12 3.5z' },
      ],
    ],
  },
  Clock: {
    flip: false,
    solid: false,
    shapes: [
      ['circle', { cx: 12, cy: 12, r: 8.5 }],
      ['path', { d: 'M12 7.5V12l3 2' }],
    ],
  },
  Pin: {
    flip: false,
    solid: false,
    shapes: [
      ['path', { d: 'M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11z' }],
      ['circle', { cx: 12, cy: 10, r: 2.4 }],
    ],
  },
  Sparkles: {
    flip: false,
    solid: false,
    shapes: [
      [
        'path',
        {
          d: 'M10 3.5 11.6 8a2 2 0 0 0 1.2 1.2l4.4 1.6-4.4 1.6a2 2 0 0 0-1.2 1.2L10 18l-1.6-4.4a2 2 0 0 0-1.2-1.2L2.8 10.8l4.4-1.6A2 2 0 0 0 8.4 8z',
        },
      ],
      ['path', { d: 'M18 14.5v5M15.5 17h5M18.5 3.5v3M17 5h3' }],
    ],
  },
  Plane: {
    flip: true,
    solid: false,
    shapes: [
      ['path', { d: 'M21 3.5 3.5 10.6l6.6 2.8 2.8 6.6z' }],
      ['path', { d: 'm10.1 13.4 4.6-4.6' }],
    ],
  },
  Alert: {
    flip: false,
    solid: false,
    shapes: [
      ['path', { d: 'M10.3 4.3 2.8 17.5A2 2 0 0 0 4.5 20.5h15a2 2 0 0 0 1.7-3L13.7 4.3a2 2 0 0 0-3.4 0z' }],
      ['path', { d: 'M12 9.5v4M12 17h.01' }],
    ],
  },
  Play: {
    flip: false,
    solid: true,
    shapes: [['path', { d: 'M8 5.6v12.8a1 1 0 0 0 1.5.86l10.2-6.4a1 1 0 0 0 0-1.72L9.5 4.74A1 1 0 0 0 8 5.6z' }]],
  },
  Mic: {
    flip: false,
    solid: false,
    shapes: [
      ['rect', { x: 9, y: 3.5, width: 6, height: 11, rx: 3 }],
      ['path', { d: 'M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v2.5' }],
    ],
  },
  Text: { flip: false, solid: false, shapes: [['path', { d: 'M5 6.5V5h14v1.5M12 5v14M9 19h6' }]] },
  Lock: {
    flip: false,
    solid: false,
    shapes: [
      ['rect', { x: 5, y: 10.5, width: 14, height: 10, rx: 2.5 }],
      ['path', { d: 'M8 10.5V8a4 4 0 0 1 8 0v2.5' }],
    ],
  },
  Sun: {
    flip: false,
    solid: false,
    shapes: [
      ['circle', { cx: 12, cy: 12, r: 3.8 }],
      [
        'path',
        {
          d: 'M12 2.8v1.9M12 19.3v1.9M4.2 4.2l1.3 1.3M18.5 18.5l1.3 1.3M2.8 12h1.9M19.3 12h1.9M4.2 19.8l1.3-1.3M18.5 5.5l1.3-1.3',
        },
      ],
    ],
  },
  Moon: { flip: false, solid: false, shapes: [['path', { d: 'M19.5 14.2A8 8 0 0 1 9.8 4.5a8 8 0 1 0 9.7 9.7z' }]] },
  Pencil: {
    flip: false,
    solid: false,
    shapes: [
      [
        'path',
        { d: 'M15.2 5.3 18.7 8.8M4.5 19.5l1-4.2L16 4.8a1.8 1.8 0 0 1 2.5 0l.7.7a1.8 1.8 0 0 1 0 2.5L8.7 18.5z' },
      ],
    ],
  },
  Info: {
    flip: false,
    solid: false,
    shapes: [
      ['circle', { cx: 12, cy: 12, r: 8.5 }],
      ['path', { d: 'M12 11v5M12 8h.01' }],
    ],
  },
  Send: {
    flip: true,
    solid: false,
    shapes: [
      ['path', { d: 'M20.5 3.5 10 14' }],
      ['path', { d: 'm20.5 3.5-6.6 17-3.9-6.5-6.5-3.9z' }],
    ],
  },
  Image: {
    flip: false,
    solid: false,
    shapes: [
      ['rect', { x: 3.5, y: 4.5, width: 17, height: 15, rx: 2.5 }],
      ['circle', { cx: 9, cy: 10, r: 1.8 }],
      ['path', { d: 'm20.5 15.5-4.5-4.5-8.5 8.5' }],
    ],
  },
  Video: {
    flip: false,
    solid: false,
    shapes: [
      ['rect', { x: 3, y: 6, width: 13, height: 12, rx: 2.5 }],
      ['path', { d: 'm16 10.5 5-3v9l-5-3z' }],
    ],
  },
  Heart: {
    flip: false,
    solid: false,
    shapes: [['path', { d: 'M12 19.5s-7.5-4.4-7.5-10A4.3 4.3 0 0 1 12 7a4.3 4.3 0 0 1 7.5 2.5c0 5.6-7.5 10-7.5 10z' }]],
  },
  Link: {
    flip: false,
    solid: false,
    shapes: [
      ['path', { d: 'M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1' }],
      ['path', { d: 'M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1' }],
    ],
  },
  Book: {
    flip: false,
    solid: false,
    shapes: [
      ['path', { d: 'M4.5 5.5A1.5 1.5 0 0 1 6 4h12.5v14H6a1.5 1.5 0 0 0-1.5 1.5z' }],
      ['path', { d: 'M4.5 19.5A1.5 1.5 0 0 0 6 21h12.5v-3M9 8h6' }],
    ],
  },
  Wifi: {
    flip: false,
    solid: false,
    shapes: [
      ['path', { d: 'M2.5 9a14 14 0 0 1 19 0M5.5 12.5a9.5 9.5 0 0 1 13 0M8.5 16a5 5 0 0 1 7 0' }],
      ['path', { d: 'M12 19.5h.01', strokeWidth: 2.6 }],
    ],
  },
  // Camera and media glyphs (same grid and stroke).
  Camera: {
    flip: false,
    solid: false,
    shapes: [
      ['path', { d: 'M4 8.5a2 2 0 0 1 2-2h1.6l1.3-2h6.2l1.3 2H18a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z' }],
      ['circle', { cx: 12, cy: 12.6, r: 3.4 }],
    ],
  },
  Flash: { flip: false, solid: false, shapes: [['path', { d: 'M13 3 5.5 13.5H12L11 21l7.5-10.5H12z' }]] },
  FlashOff: {
    flip: false,
    solid: false,
    shapes: [
      ['path', { d: 'M13 3 5.5 13.5H12L11 21l7.5-10.5H12z' }],
      ['path', { d: 'm3.5 3.5 17 17' }],
    ],
  },
  Flip: {
    flip: false,
    solid: false,
    shapes: [
      ['path', { d: 'M4.5 12a7.5 7.5 0 0 1 13.2-4.9M19.5 12a7.5 7.5 0 0 1-13.2 4.9' }],
      ['path', { d: 'M18 3.5v4h-4M6 20.5v-4h4' }],
    ],
  },
  VolumeOff: {
    flip: false,
    solid: false,
    shapes: [
      ['path', { d: 'M4.5 9.5h3L12 6v12l-4.5-3.5h-3z' }],
      ['path', { d: 'm16 9.5 5 5m0-5-5 5' }],
    ],
  },
  Volume: {
    flip: false,
    solid: false,
    shapes: [
      ['path', { d: 'M4.5 9.5h3L12 6v12l-4.5-3.5h-3z' }],
      ['path', { d: 'M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11' }],
    ],
  },
  Palette: {
    flip: false,
    solid: false,
    shapes: [
      [
        'path',
        {
          d: 'M12 3.5a8.5 8.5 0 0 0 0 17c1.2 0 1.8-.8 1.8-1.7 0-1.2-1-1.6-1-2.6 0-.9.7-1.5 1.6-1.5h2.1a4 4 0 0 0 4-4c0-4-3.8-7.2-8.5-7.2z',
        },
      ],
      ['path', { d: 'M8 11h.01M10.5 7.5h.01M15 7.8h.01', strokeWidth: 2.6 }],
    ],
  },
  Battery: {
    flip: false,
    solid: false,
    shapes: [
      ['rect', { x: 3, y: 7.5, width: 16, height: 9, rx: 2 }],
      ['path', { d: 'M21 10.5v3M6.5 10.5v3M9.5 10.5v3' }],
    ],
  },
  Signal: { flip: false, solid: false, shapes: [['path', { d: 'M5 19.5v-3M9.5 19.5v-6M14 19.5v-9M18.5 19.5v-13' }]] },
  Stop: { flip: false, solid: true, shapes: [['rect', { x: 6.5, y: 6.5, width: 11, height: 11, rx: 2.5 }]] },
  Pause: {
    flip: false,
    solid: true,
    shapes: [
      ['rect', { x: 6.5, y: 5.5, width: 4, height: 13, rx: 1.4 }],
      ['rect', { x: 13.5, y: 5.5, width: 4, height: 13, rx: 1.4 }],
    ],
  },
  Upload: {
    flip: false,
    solid: false,
    shapes: [
      ['path', { d: 'M12 15.5v-11M7.5 9 12 4.5 16.5 9' }],
      ['path', { d: 'M4.5 15v3a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-3' }],
    ],
  },
  Dots: { flip: false, solid: false, shapes: [['path', { d: 'M6 12h.01M12 12h.01M18 12h.01', strokeWidth: 3 }]] },
} satisfies Record<string, IconDef>;

export type IconName = keyof typeof ICONS;

export function Icon({
  name,
  size = 24,
  color,
  strokeWidth = 1.8,
}: {
  name: IconName;
  size?: number;
  color: string;
  strokeWidth?: number;
}) {
  const def: IconDef = ICONS[name];
  const mirror = def.flip && I18nManager.isRTL;
  return (
    <Svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={def.solid ? color : 'none'}
      stroke={color}
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={mirror ? { transform: [{ scaleX: -1 }] } : undefined}
      accessible={false}
      importantForAccessibility="no-hide-descendants"
    >
      {def.shapes.map((shape, i) => {
        const key = `${name}-${i}`;
        if (shape[0] === 'path') return <Path key={key} {...shape[1]} />;
        if (shape[0] === 'circle') return <Circle key={key} {...shape[1]} />;
        return <Rect key={key} {...shape[1]} />;
      })}
    </Svg>
  );
}
