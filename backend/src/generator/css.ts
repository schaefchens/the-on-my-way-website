/**
 * Inline critical CSS of the pre-rendered first screen.
 *
 * - Scoped to `.omw-fs*` classes: the readable article no-JS readers get inside <noscript> (the
 *   visible first screen of JS readers is the twin, twin.ts, styled by the site's own Tailwind
 *   stylesheet plus PageStyles geometry). html/body are styled by the site's stylesheet.
 * - Colours use the @omw/ui runtime tokens (--omw-bg, --omw-ink, …, defined with light-dark()
 *   by theme.css) with the dawn/dusk palette values as fallbacks, so the first screen follows
 *   the same theme and the OS colour scheme even before the stylesheet applies.
 * - Fonts: the @omw/ui families (Fraunces display, Nunito body, Playpen Sans notes); the
 *   @font-face rules come from the site stylesheet.
 * - Per-page dynamic rules (dominant image colours, WhatsApp text-status colours and fonts) are
 *   generated from validated values only (#rrggbb / #rrggbbaa / FontName); no style attributes
 *   are ever written, so the CSP needs no 'unsafe-inline' (each <style> is hashed instead).
 */
import type { FontName } from '@omw/contracts/wa';

const FONT_BODY =
  '"Nunito Variable", "Vazirmatn Variable", "Rubik Variable", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif';
const FONT_DISPLAY = '"Fraunces Variable", "Vazirmatn Variable", "Rubik Variable", ui-serif, Georgia, serif';
const FONT_HAND =
  '"Playpen Sans Variable", "Playpen Sans Arabic Variable", "Playpen Sans Hebrew Variable", ui-rounded, sans-serif';

export const CRITICAL_CSS = [
  ':root{--fs-bg:var(--omw-bg,#fff8f6);--fs-surface:var(--omw-surface,#fff);--fs-surface2:var(--omw-surface-2,#fce7ee);',
  '--fs-ink:var(--omw-ink,#3b2341);--fs-muted:var(--omw-muted,#6a4e6f);--fs-line:var(--omw-line,#f7d0dd);',
  '--fs-accent:var(--omw-accent,#be4a74);--fs-lilac:var(--omw-lilac,#eee6fa)}',
  '@media (prefers-color-scheme:dark){:root{--fs-bg:var(--omw-bg,#1b1322);--fs-surface:var(--omw-surface,#251a2e);',
  '--fs-surface2:var(--omw-surface-2,#30243b);--fs-ink:var(--omw-ink,#f7ecf2);--fs-muted:var(--omw-muted,#c9b6cc);',
  '--fs-line:var(--omw-line,#3f2f4b);--fs-accent:var(--omw-accent,#f4a3bc);--fs-lilac:var(--omw-lilac,#2d2442)}}',
  `.omw-fs{box-sizing:border-box;max-width:44rem;margin:0 auto;padding:1rem 1rem 4rem;color:var(--fs-ink);font-family:${FONT_BODY};font-size:1rem;line-height:1.55}`,
  '.omw-fs *{box-sizing:border-box}',
  '.omw-fs a{color:var(--fs-accent);text-underline-offset:.15em}',
  '.omw-fs-top{display:flex;flex-wrap:wrap;align-items:baseline;justify-content:space-between;gap:.5rem 1rem;padding:.5rem 0 1rem;font-size:.9rem}',
  `.omw-fs-brand{font-family:${FONT_DISPLAY};font-weight:650;font-size:1.15rem;color:var(--fs-ink)!important;text-decoration:none}`,
  '.omw-fs-langs{display:flex;gap:.75rem;margin:0;padding:0;list-style:none}',
  '.omw-fs-langs [aria-current]{font-weight:700;color:var(--fs-ink);text-decoration:none}',
  '.omw-fs-kicker{margin:1.25rem 0 .25rem;color:var(--fs-muted);font-size:.875rem;font-weight:700}',
  `.omw-fs h1,.omw-fs h2,.omw-fs h3{font-family:${FONT_DISPLAY};font-variation-settings:"SOFT" 100;line-height:1.15;margin:0 0 .5rem;overflow-wrap:anywhere}`,
  '.omw-fs h1{font-size:clamp(1.9rem,6vw,2.6rem);font-weight:650}',
  '.omw-fs h2{font-size:1.35rem;font-weight:600;margin-top:2rem}',
  '.omw-fs h3{font-size:1.1rem;font-weight:600}',
  '.omw-fs p{margin:.5rem 0}',
  '.omw-fs-lead{color:var(--fs-muted);font-size:1.05rem}',
  '.omw-fs-meta{color:var(--fs-muted);font-size:.875rem}',
  '.omw-fs-pic{display:block;margin:1rem 0 .5rem}',
  '.omw-fs-img{display:block;width:100%;height:auto;border-radius:1rem;background:var(--fs-surface2)}',
  '.omw-fs-entries{list-style:none;margin:1.5rem 0 0;padding:0;display:grid;gap:1.75rem}',
  '.omw-fs-entry>.omw-fs-meta{display:block;font-weight:700}',
  '.omw-fs-user{white-space:pre-line;overflow-wrap:anywhere;unicode-bidi:plaintext}',
  '.omw-fs-desc{color:var(--fs-ink)}',
  '.omw-fs-orig{display:block;color:var(--fs-muted);font-size:.75rem}',
  `.omw-fs-note{font-family:${FONT_HAND};background:var(--fs-surface2);border-radius:1rem;padding:1rem 1.25rem;margin:.5rem 0;font-size:1.05rem}`,
  '.omw-fs-text{display:flex;align-items:center;justify-content:center;min-height:9rem;border-radius:1rem;padding:2rem 1.25rem;margin:.5rem 0;text-align:center;font-size:1.3rem;line-height:1.35}',
  '.omw-fs-card{display:block;background:var(--fs-surface);border:1px solid var(--fs-line);border-radius:1rem;padding:1rem 1.25rem;margin:.5rem 0}',
  '.omw-fs-nav{display:flex;justify-content:space-between;gap:1rem;margin-top:2.5rem;padding-top:1rem;border-top:1px solid var(--fs-line)}',
  '.omw-fs-list{list-style:none;margin:1rem 0 0;padding:0;display:grid;gap:.75rem}',
  '.omw-fs-row{display:grid;grid-template-columns:5.5rem 1fr;gap:.9rem;align-items:center;color:inherit!important;text-decoration:none;background:var(--fs-surface);border:1px solid var(--fs-line);border-radius:1rem;padding:.5rem}',
  '.omw-fs-tpic{display:contents}',
  '.omw-fs-row .omw-fs-img{width:5.5rem;height:5.5rem;object-fit:cover;border-radius:.75rem}',
  '.omw-fs-row strong{display:block;line-height:1.25}',
  '.omw-fs-ph{display:block;width:5.5rem;height:5.5rem;border-radius:.75rem;background:var(--fs-lilac)}',
  '.omw-fs-story{font-size:1.075rem}',
  '.omw-fs-story blockquote{margin:1rem 0;padding:.25rem 1rem;border-inline-start:3px solid var(--fs-line);color:var(--fs-muted)}',
  // Markdown lists keep their markers (Tailwind's preflight removes them, L3-17), in the accent.
  '.omw-fs-story ul,.omw-fs-story ol{padding-inline-start:1.5rem;margin:.75rem 0}',
  '.omw-fs-story ul{list-style:disc}.omw-fs-story ol{list-style:decimal}',
  '.omw-fs-story li{margin:.25rem 0}.omw-fs-story li::marker{color:var(--fs-accent)}',
  // Owner text keeps its own direction but aligns like the page (L3-13): a Latin title on an
  // RTL page sits at the right edge with its meta line. Chromium/WebKit know only the prefixed
  // keyword; Firefox the standard one.
  '.omw-fs [dir=auto]{text-align:-webkit-match-parent;text-align:match-parent;unicode-bidi:plaintext}',
].join('');

/** CSS font stacks for WhatsApp text-status fonts (D10, same mapping as @omw/ui/fonts). */
const WA_FONT_RULES: Readonly<Record<FontName, string>> = {
  SYSTEM: 'font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;font-weight:400',
  SYSTEM_BOLD: 'font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;font-weight:700',
  SYSTEM_TEXT: 'font-family:ui-serif,Georgia,"Times New Roman",serif;font-weight:400',
  FB_SCRIPT: `font-family:${FONT_HAND};font-weight:500`,
  MORNINGBREEZE_REGULAR: 'font-family:"Nunito Variable",ui-rounded,system-ui,sans-serif;font-weight:800',
  CALISTOGA_REGULAR: 'font-family:"Calistoga",ui-serif,Georgia,serif;font-weight:400',
  EXO2_EXTRABOLD: 'font-family:"Exo 2 Variable",system-ui,sans-serif;font-weight:800',
  COURIERPRIME_BOLD: 'font-family:"Courier Prime",ui-monospace,monospace;font-weight:700',
};

/** Viewport widths where the SPA's timeline metrics change (timeline/model.ts metricsFor). */
export const BREAKPOINTS = { regular: 704, wide: 1024 } as const;

export type GeometryValue = number | string;
export type GeometryProps = Readonly<Record<string, GeometryValue>>;

const GEOMETRY_PROPS = new Set([
  'height',
  'width',
  'top',
  'inset-inline-start',
  'inset-block-start',
  'inset-block-end',
  'inline-size',
  'rotate',
]);

function geometryValue(v: GeometryValue): string {
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new RangeError(`Invalid geometry value: ${v}`);
    return `${Math.round(v * 1000) / 1000}px`;
  }
  // deg values and min()/calc() of px, rem, % and the spacing token
  if (!/^(?:-?\d+(?:\.\d+)?deg|min\(calc\(100% \+ 0\.75rem - var\(--spacing-gutter\)\), \d+px\))$/.test(v)) {
    throw new RangeError(`Invalid geometry value: ${v}`);
  }
  return v;
}

function shortHash(text: string): string {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36);
}

const HEX6 = /^#[0-9a-f]{6}$/;
const HEX8 = /^#[0-9a-f]{8}$/;

/** Collects the dynamic, validated CSS rules a page needs; class names are derived from values. */
export class PageStyles {
  private readonly rules = new Map<string, string>();

  /** Background colour placeholder of an image ("#rrggbb"). */
  imageColor(hex: string): string {
    if (!HEX6.test(hex)) throw new RangeError(`Invalid image colour: ${hex}`);
    const cls = `omw-c-${hex.slice(1)}`;
    this.rules.set(cls, `.${cls}{background-color:${hex}}`);
    return cls;
  }

  /** WhatsApp text status colours ("#rrggbbaa"). */
  textColors(bg: string, fg: string): string {
    if (!HEX8.test(bg) || !HEX8.test(fg)) throw new RangeError(`Invalid text status colours: ${bg} ${fg}`);
    const cls = `omw-t-${bg.slice(1)}-${fg.slice(1)}`;
    this.rules.set(cls, `.${cls}{background-color:${bg};color:${fg}}`);
    return cls;
  }

  waFont(font: FontName): string {
    const rule = WA_FONT_RULES[font];
    if (!rule) throw new RangeError(`Unknown WhatsApp font: ${font}`);
    const cls = `omw-wa-${font.toLowerCase().replace(/_/g, '-')}`;
    this.rules.set(cls, `.${cls}{${rule}}`);
    return cls;
  }

  /**
   * A geometry rule of the first-screen twin (twin.ts): `props` per breakpoint of the SPA's
   * timeline metrics (compact < 704 px viewport <= regular < 1024 px <= wide). Values are numbers
   * (px) or short validated keyword/function strings; property names come from a fixed list. The
   * class name is derived from the content, so equal geometry shares one rule.
   */
  geometry(prefix: string, base: GeometryProps, regular?: GeometryProps, wide?: GeometryProps): string {
    if (!/^[a-z][a-z0-9-]{0,15}$/.test(prefix)) throw new RangeError(`Invalid geometry prefix: ${prefix}`);
    const decl = (props: GeometryProps) =>
      Object.entries(props)
        .map(([k, v]) => {
          if (!GEOMETRY_PROPS.has(k)) throw new RangeError(`Geometry property not allowed: ${k}`);
          return `${k}:${geometryValue(v)}`;
        })
        .join(';');
    const parts = [decl(base), regular ? decl(regular) : '', wide ? decl(wide) : ''];
    const cls = `omw-${prefix}-${shortHash(parts.join('|'))}`;
    let css = parts[0] ? `.${cls}{${parts[0]}}` : '';
    if (parts[1]) css += `@media (min-width:${BREAKPOINTS.regular}px){.${cls}{${parts[1]}}}`;
    if (parts[2]) css += `@media (min-width:${BREAKPOINTS.wide}px){.${cls}{${parts[2]}}}`;
    this.rules.set(cls, css);
    return cls;
  }

  /** Inline-style replacement for a custom property holding a colour ("--glow:#a1b2c3"). */
  glow(hex: string): string {
    if (!HEX6.test(hex)) throw new RangeError(`Invalid glow colour: ${hex}`);
    const cls = `omw-g-${hex.slice(1)}`;
    this.rules.set(cls, `.${cls}{--glow:${hex}}`);
    return cls;
  }

  /**
   * object-position of a portrait's focus point (fractions 0..1 from the image's left and top
   * edges, physical: never mirrored in RTL). Rounded to 0.1 % like the SPA (profile.tsx).
   */
  objectPosition(focus: { x: number; y: number }): string {
    const pct = (v: number) => {
      if (!Number.isFinite(v) || v < 0 || v > 1) throw new RangeError(`Invalid focus value: ${v}`);
      return Math.round(v * 1000) / 10;
    };
    const x = pct(focus.x);
    const y = pct(focus.y);
    const cls = `omw-fp-${String(x).replace('.', '_')}-${String(y).replace('.', '_')}`;
    this.rules.set(cls, `.${cls}{object-position:${x}% ${y}%}`);
    return cls;
  }

  /** Background image of a data: URL (ThumbHash placeholders; img-src allows data:). */
  backgroundData(url: string): string {
    if (!/^data:image\/png;base64,[A-Za-z0-9+/]+=*$/.test(url)) throw new RangeError('Invalid data URL');
    const cls = `omw-bg-${shortHash(url)}`;
    this.rules.set(cls, `.${cls}{background-image:url("${url}");background-size:cover;background-position:center}`);
    return cls;
  }

  /** A fixed rule set by name (twin.ts helpers; the CSS is static source code). */
  fixed(cls: string, css: string): string {
    if (!/^omw-[a-z0-9-]+$/.test(cls) || css.includes('</')) throw new RangeError(`Invalid fixed rule ${cls}`);
    this.rules.set(cls, css);
    return cls;
  }

  /** Critical CSS plus this page's rules (sorted, so output is deterministic). */
  css(): string {
    return (
      CRITICAL_CSS +
      [...this.rules.keys()]
        .sort()
        .map((k) => this.rules.get(k))
        .join('')
    );
  }
}
