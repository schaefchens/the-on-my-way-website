// @vitest-environment jsdom
/**
 * The neutral page's inline script (spec-wave5 §2.5, NEUTRAL_SCRIPT, byte for byte): a device
 * with a key cookie resumes at most once per 5 minutes, remembered in a cookie because every
 * refusal's Clear-Site-Data empties sessionStorage; the paste field forwards only a personal link.
 * The generator owns the constant (WP2); this pins the behaviour the gate pages rely on.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { K, rawCookie, resetDom, setCookie, T } from './harness';

const NEUTRAL_SCRIPT = `(function(){try{var c=document.cookie.split('; '),h=function(n){return c.some(function(x){return x.indexOf(n+'=')===0})};if(h('{{KK}}')&&!h('{{RK}}')){document.cookie='{{RK}}=1; Path=/; Max-Age=300; {{SEC}}SameSite=Strict';location.replace('/_/join/#resume');return;}}catch(e){}var f=document.getElementById('p');if(f)f.addEventListener('submit',function(e){e.preventDefault();var m=/#t=([A-Za-z0-9_-]{43})/.exec(document.getElementById('u').value);if(m)location.assign('/_/join/#t='+m[1]);});})();`;

const script = NEUTRAL_SCRIPT.replaceAll('{{KK}}', '__Host-omw_k')
  .replaceAll('{{RK}}', '__Host-omw_r')
  .replaceAll('{{SEC}}', 'Secure; ');

/** Runs the script against the real (jsdom) document with a recording `location`. */
function runNeutral(): string[] {
  const navs: string[] = [];
  const location = {
    replace: (u: string) => navs.push(`replace ${u}`),
    assign: (u: string) => navs.push(`assign ${u}`),
  };
  new Function('document', 'location', script)(document, location);
  return navs;
}

beforeEach(() => {
  resetDom();
  document.body.insertAdjacentHTML(
    'beforeend',
    '<form id="p"><input id="u" type="url"><button type="submit">→</button></form>',
  );
});

describe('neutral page script', () => {
  it('resumes a device with a key, at most once per 5 minutes, also after sessionStorage was cleared', () => {
    setCookie('__Host-omw_k', K);
    expect(runNeutral()).toEqual(['replace /_/join/#resume']);
    expect(document.cookie).toContain('__Host-omw_r=1');
    // Clear-Site-Data "storage" on the next refusal: sessionStorage is gone, cookies stay.
    window.sessionStorage.clear();
    window.localStorage.clear();
    expect(runNeutral()).toEqual([]);
    expect(runNeutral()).toEqual([]);
  });

  it('resumes again once the throttle cookie expired', () => {
    setCookie('__Host-omw_k', K);
    expect(runNeutral()).toHaveLength(1);
    rawCookie('__Host-omw_r=; Path=/; Max-Age=0; Secure; SameSite=Strict');
    expect(runNeutral()).toEqual(['replace /_/join/#resume']);
  });

  it('does nothing for a stranger (no key cookie)', () => {
    expect(runNeutral()).toEqual([]);
    expect(document.cookie).not.toContain('__Host-omw_r');
  });

  it('forwards a pasted personal link, and nothing else', () => {
    const navs: string[] = [];
    const location = { replace: (u: string) => navs.push(u), assign: (u: string) => navs.push(u) };
    new Function('document', 'location', script)(document, location);
    const input = document.getElementById('u') as HTMLInputElement;
    const form = document.getElementById('p') as HTMLFormElement;
    input.value = `https://site.example/_/join/#t=${T}`;
    form.dispatchEvent(new Event('submit', { cancelable: true }));
    input.value = 'https://evil.example/#x=1';
    form.dispatchEvent(new Event('submit', { cancelable: true }));
    expect(navs).toEqual([`/_/join/#t=${T}`]);
  });
});
