# Font subsetting

`subset-playpen.sh` builds the handwriting font of the site and the admin (Playpen Sans, OFL)
from `@fontsource-variable/playpen-sans` into `frontend/shared/fonts/playpen-sans/`. The output
is committed; the site, the admin and the Docker image only use those files, so nobody needs
Python to build the apps.

```sh
scripts/fonts/subset-playpen.sh            # rebuild after bumping @fontsource-variable/playpen-sans
pnpm --filter @omw/ui fonts                # then regenerate frontend/shared/src/styles/fonts.css
scripts/fonts/subset-playpen.sh --check    # rebuilds under .cache/ and compares byte for byte
```

The wrapper creates `.cache/venv-fonts` with the pinned `fonttools` and `brotli` from
`requirements.txt` (wheels only; Python 3.13 by default, override with `OMW_FONTS_PYTHON`).
`pnpm --filter @omw/ui fonts` and `fonts:check` refuse to run when the installed Playpen package
is not the one the subsets were built from (source hashes in `subsets.json`).

## Output

| File | Content |
|---|---|
| `playpen-sans-latin-{400,500}.woff2` | Basic Latin, Latin-1, typographic punctuation (‘’‚“”„–—…•·€ …), Œœ ı, common combining marks |
| `playpen-sans-vietnamese-{400,500}.woff2` | Ă Đ Ĩ Ũ Ơ Ư, U+1EA0–1EF9, tone marks, ₫ |
| `playpen-sans-latin-ext-{400,500}.woff2` | the rest of Latin Extended-A, Ș ș Ț ț, ẞ, Welsh ẁ ẃ ẅ |
| `subsets.json` | code points (`unicodeRange`), sizes, hashes and the source hashes; `fonts.css` is built from it |
| `OFL.txt` | the font's license (SIL Open Font License 1.1) |

Each file is a separate `@font-face` with its `unicode-range`, so a German or English page only
downloads the Latin file, and Vietnamese place names add the small Vietnamese one. The Arabic and
Hebrew cuts of Playpen stay the upstream variable files: they load only for those scripts.

The font declares no Reserved Font Name (neither in `LICENSE` nor in its name table, the script
checks both), so the subsets keep the family name. In CSS the family is still called
`Playpen Sans Variable`, the name `theme.css`, `@omw/ui/fonts` and the generator use.

## Decisions (2026-11-20)

Sizes in KiB (1024 bytes). Page numbers are bytes on the wire, measured with the fixtures
(`backend/src/generator/cli.ts demo`: generated pages served by the generator's static server;
the admin against its e2e mock API; Chromium, cold cache, desktop and Pixel 7 alike):

| Hand font on … | before (fontsource) | after |
|---|---|---|
| home `/de/`, `/en/` (Latin + Vietnamese words in notes) | 240.8 | 31.0 |
| day page `/de/day/2026-11-15/` | 240.8 | 31.0 |
| story page `/de/day/2026-11-15/story/p_s01lantern/` (Đ pulled the latin-ext file) | 499.4 | 31.0 |
| admin login, trips, composer (Latin text only) | 192.0 | 24.0 |
| admin inbox (an `FB_SCRIPT` status in Vietnamese, worst case) | 240.7 | 62.8 |

- **Weights.** Every hand-font text in the site and the admin renders at 400; WhatsApp text
  statuses in `FB_SCRIPT` use 500 (`WA_FONTS`, generator `css.ts`). One static instance per
  weight beats a variable font limited to the used range on real pages: Latin 23.8 (400) and
  24.5 (500) vs 37.9 for `wght 400–500` (41.1 for 400–700); Latin + Vietnamese 30.5 vs 48.5.
  Only a page that shows an `FB_SCRIPT` status *and* Vietnamese text in the hand font loads all
  four Latin/Vietnamese files (61.9; the variable font would need 48.5 there). Bold text in the
  hand font (none today) would use the 500 file with synthetic bold.
- **Features.** Kept: `ccmp`, `locl`, `liga`, `kern`, `dist` (Playpen keeps pair adjustments
  there), `mark`, `mkmk` (Vietnamese stacked marks) and `rvrn`. Dropped: `calt` and `frac`.
  Playpen's `calt` cycles 4–6 alternates of every letter (and of the space) to imitate
  handwriting; that is two thirds of the glyphs (759 → 264 in the Latin file), and the static
  Latin file would be 77.1 with it. Side-by-side renderings in de, en and vi at 14–56 px
  (`.cache/shots/wave4/fonts/`) show the difference only on repeated letters at display sizes
  ("lllll", "eeee" are identical instead of slightly varied); at UI sizes it is not visible.
  Apart from that, the subsets render pixel-identical to the upstream font with `calt` off for
  the de, en and European samples. In Vietnamese words, Chromium now draws a tone mark on a
  Latin-1 base letter (ầ = â + ◌̀) from the Latin file, so such letters are kerned against their
  neighbours (up to 1.5 px narrower per word at 56 px); the shapes are the same.
- **Display.** `font-display: swap`. The site is a single-page app: with `optional`, a first
  visit that misses the ~100 ms block period keeps the fallback for the whole session, and the
  tagline, month headings and notes would never look handwritten. The files are small now, the
  hand-font texts are short lines, and swap keeps them readable while the font loads.
- **Preload only where it is on the first screen** (changed 2026-11-20, review wave 4). The
  generator preloads the Latin Nunito and Fraunces files (and their Vietnamese subsets on
  Vietnamese pages) everywhere, and `playpen-sans-latin-400` only on pages whose pre-rendered
  first screen has hand-font text (`pages.ts` `handFontText`: the greeting or tagline and the
  month headings of home and trip pages, notes); the Vietnamese 400 file only when that text
  needs it, never the 500 weight (asserted in `backend/test/generator/html.test.ts`). Without
  the preload, a cold visit at 1.6 Mbit/s painted the greeting in Nunito for about 2 s before
  the swap (no layout shift: the line boxes are the same). Elsewhere Chromium fetches the hand
  font at its default font priority (VeryHigh) as soon as a hand-font text is laid out; on day
  and story pages that is the timeline that stays mounted (inert) under the player. The
  player's note preload asks for weight 400.
- **Not included:** emoji and pictographs. The tagline's ✈︎ keeps coming from the system font;
  Playpen draws U+2708 as a paper plane in its emoji subsets (`.cache/shots/wave4/fonts/03-*`),
  which would be a design change.
