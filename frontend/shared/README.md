# @omw/ui — design tokens and shared UI

Shared by the public site (`@omw/site`) and the admin PWA (`@omw/admin`). Consumed as TypeScript/CSS source, without a build step.

```css
/* app.css */
@import "tailwindcss";
@import "@omw/ui/theme.css";
```

```ts
// main.tsx: load the @font-face rules once
import '@omw/ui/fonts.css';
```

## Themes

| Theme | When |
|---|---|
| **dawn** (light) | default, or `<html data-theme="dawn">` |
| **dusk** (night) | `prefers-color-scheme: dark`, or `<html data-theme="night">` |

`data-theme` also works on any subtree. The `dark:` variant means the night theme: it is forced through `data-theme="night"`, or follows the OS unless `data-theme="dawn"` is set. Semantic tokens switch automatically, so `dark:` should rarely be needed.

## Colour tokens

Tailwind's default palette is removed (`--color-*: initial`), so only these colours exist.

**Semantic** (`bg-bg`, `text-ink`, `bg-accent`, `ring-ring`, …):

| Token | dawn | dusk | Use |
|---|---|---|---|
| `bg` | `#FFF8F6` cream | `#1B1322` | page background |
| `surface` | `#FFFFFF` | `#251A2E` | cards, sheets |
| `surface-2` | `#FCE7EE` | `#30243B` | raised / alternate surfaces |
| `ink` | `#3B2341` plum (13.3:1) | `#F7ECF2` | text |
| `muted` | `#6A4E6F` | `#C9B6CC` | secondary text |
| `line` | `#F7D0DD` | `#3F2F4B`* | borders, dividers |
| `accent` | `#BE4A74` rose-600 (white 4.75:1) | `#F4A3BC` | buttons, links |
| `accent-strong` | `#9C3A5E` rose-700 | `#F8C1D2`* | hover / pressed |
| `on-accent` | `#FFFFFF` | `#1B1322` | text on `accent` |
| `blush` / `blush-strong` | `#FCE7EE` / `#F7D0DD` | `#3A2235`* / `#4D2B45`* | soft rose fills |
| `violet` | `#5D3FA0` | `#BCA4F2` | secondary accent |
| `lilac` / `lilac-strong` | `#EEE6FA` / `#CDB8F0` | `#2D2442`* / `#46386B`* | soft violet fills |
| `ring` | `#8E6BD6` | `#BCA4F2` | focus outline |
| `danger` / `success` | `#B42318` / `#1F7A4D`* | `#FFA39E`* / `#8FDCB4`* | status |

Values marked * are not in the plan; they are derived from it and up for review.

**Raw palette** (static, same in both themes): `cream`, `plum-50/300/600/800/850/900/950`, `rose-100/200/300/600/700`, `lilac-100/300`, `violet-300/500/700`, `white`, `black`.

The runtime values are CSS variables `--omw-*` on `:root` and on every `[data-theme]` element, defined with `light-dark()`. Lightning CSS lowers `light-dark()` for older browsers in production builds.

## Type

| Token | Families | Use |
|---|---|---|
| `font-display` | Fraunces Variable (wght + **SOFT** axes) → Vazirmatn / Rubik → serif | headings, day titles |
| `font-body` (= `font-sans`) | Nunito Variable (+ italic) → Vazirmatn (Arabic/Persian) → Rubik (Hebrew) → system | UI and body text |
| `font-hand` | Playpen Sans (static 400/500 subsets, family name `Playpen Sans Variable`) + its Arabic and Hebrew cuts | tagline, month headings, notes, greeting, a few labels |

Each stack ends with colour-emoji fonts. Use `font-variation-settings: "SOFT" 100` for the soft Fraunces look.

Only the needed subsets are shipped: latin, latin-ext and vietnamese, plus the arabic and hebrew cuts. Playpen's monochrome emoji subsets are left out on purpose. `src/styles/fonts.css` is **generated** from the installed `@fontsource` packages and, for the Latin Playpen faces, from the committed subsets in `fonts/playpen-sans/` (`subsets.json`):

```sh
scripts/fonts/subset-playpen.sh     # (repo root) only after bumping @fontsource-variable/playpen-sans
pnpm --filter @omw/ui fonts         # regenerate after bumping a @fontsource package
pnpm --filter @omw/ui fonts:check   # CI: fails if out of date or the Playpen subsets are stale
```

The handwriting subsets are static instances at the two weights the UI uses (400; 500 for `FB_SCRIPT` text statuses) without Playpen's contextual handwriting alternates (`calt`), split into latin / vietnamese / latin-ext files: about 24 KiB on a German or English page, 31 KiB with Vietnamese place names (was 190–500 KiB). Use the hand font only at 400 or 500; any other weight falls back to the nearest file (bold is synthesized). Why and how: [scripts/fonts/README.md](../../scripts/fonts/README.md). License: `fonts/playpen-sans/OFL.txt`.

**WhatsApp text statuses** (D10). Use `waFontStyle(font)` from `@omw/ui/fonts`, which sets the CSS variable and the weight:

| FontName | Substitute |
|---|---|
| `SYSTEM`, `SYSTEM_BOLD` | `system-ui` 400 / 700 |
| `SYSTEM_TEXT` | `ui-serif` |
| `FB_SCRIPT` | Playpen Sans (script substitute) |
| `MORNINGBREEZE_REGULAR` | Nunito 800 (rounded) |
| `CALISTOGA_REGULAR` | Calistoga |
| `EXO2_EXTRABOLD` | Exo 2 800 |
| `COURIERPRIME_BOLD` | Courier Prime 700 |

`preloadWaFont(font, text)` warms the face before the player shows an item.

## Shape, depth, motion

| Token | Value |
|---|---|
| `rounded-tile` / `rounded-card` / `rounded-sheet` / `rounded-pill` | 1rem / 1.5rem / 2rem / full |
| `p-gutter`, `px-gutter-wide`, `py-section` … | 1rem / 2rem / 3rem |
| `shadow-soft` / `shadow-lift` / `shadow-float` | rose-tinted by day, deep neutral at night |
| `ease-soft` / `ease-snappy` / `ease-float` | CSS easings |
| `animate-here-now` | pulsing ring for the "here now" chip |
| `paper-grain`, `washi-tape` | utilities for the signature touches |

The JS springs for Motion live in `@omw/ui/motion`:

| Preset | Spring |
|---|---|
| `SPRINGS.soft` | `visualDuration` 0.35 s, bounce 0.15 |
| `SPRINGS.snappy` | 0.2 s, no bounce |
| `SPRINGS.float` | 0.8 s |

`MOTION_CONFIG` is `{ reducedMotion: 'user' }`. `ZOOM_GESTURE` holds the pinch limits: scale 0.85–1.2, with a level change at |ln s| > 0.18.

## Components and helpers

**`<Picture image={ImageSet} alt sizes />`** renders AVIF, then WebP, then an `<img>`. It writes `srcset` for each width and sets the `width`/`height` attributes. Until the image loads, the dominant colour and the ThumbHash sit behind it. URLs are resolved against the basePath from `<MediaBaseProvider basePath>` (D3).

**`@omw/ui/locale`**
- `dirOf` / `isRtl` / `forwardSign`, taken from `@omw/contracts` LOCALES
- `availableLocales(includeDevOnly)` (build defaults) and `enabledLocales(configured, includeDevOnly)` (runtime: the site's configured locales)
- `useDocumentLocale`, which keeps `<html lang dir>` in sync
- cached Intl formatters: `formatLocalDate`, `formatLocalDateRange`, `formatTime` (in the traveler's zone), `formatRelative`
- `countryName` / `languageName` (Intl.DisplayNames) and `countryFlag`

**`@omw/ui/thumbhash`**: `thumbhashToDataUrl`, `thumbhashAverageColor`, `thumbhashAspectRatio`.
