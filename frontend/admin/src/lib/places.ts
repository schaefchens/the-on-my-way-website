/** Countries (ISO 3166-1 alpha-2, named via Intl.DisplayNames) and IANA time zones. */
import type { LocaleCode } from '@omw/contracts/i18n';
import { isValidTimeZone, localDateFor, localTimeFor, utcOffsetMinutes } from '@omw/contracts/time';
import { countryName, intlLocale } from '@omw/ui/locale';

/** Officially assigned ISO 3166-1 alpha-2 codes. */
const ISO_3166 =
  'AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW'.split(
    ' ',
  );

export interface CountryOption {
  code: string;
  name: string;
}

const countryCache = new Map<LocaleCode, CountryOption[]>();

/** All countries, sorted by their name in the UI locale. */
export function countryOptions(locale: LocaleCode): CountryOption[] {
  let list = countryCache.get(locale);
  if (!list) {
    const collator = new Intl.Collator(intlLocale(locale));
    list = ISO_3166.map((code) => ({ code, name: countryName(code, locale) })).sort((a, b) =>
      collator.compare(a.name, b.name),
    );
    countryCache.set(locale, list);
  }
  return list;
}

/**
 * Legacy names that ICU (and so Chromium) still reports as canonical, mapped to the current
 * IANA names. The API validates against PHP's DateTimeZone::listIdentifiers(), which contains
 * only current names, so "Asia/Saigon" from the browser must become "Asia/Ho_Chi_Minh".
 */
const LEGACY_ZONES: Readonly<Record<string, string>> = {
  'Africa/Asmera': 'Africa/Asmara',
  'America/Buenos_Aires': 'America/Argentina/Buenos_Aires',
  'America/Catamarca': 'America/Argentina/Catamarca',
  'America/Coral_Harbour': 'America/Atikokan',
  'America/Cordoba': 'America/Argentina/Cordoba',
  'America/Godthab': 'America/Nuuk',
  'America/Indianapolis': 'America/Indiana/Indianapolis',
  'America/Jujuy': 'America/Argentina/Jujuy',
  'America/Louisville': 'America/Kentucky/Louisville',
  'America/Mendoza': 'America/Argentina/Mendoza',
  'America/Montreal': 'America/Toronto',
  'America/Nipigon': 'America/Toronto',
  'America/Pangnirtung': 'America/Iqaluit',
  'America/Rainy_River': 'America/Winnipeg',
  'America/Santa_Isabel': 'America/Tijuana',
  'America/Thunder_Bay': 'America/Toronto',
  'America/Yellowknife': 'America/Edmonton',
  'Asia/Calcutta': 'Asia/Kolkata',
  'Asia/Choibalsan': 'Asia/Ulaanbaatar',
  'Asia/Katmandu': 'Asia/Kathmandu',
  'Asia/Rangoon': 'Asia/Yangon',
  'Asia/Saigon': 'Asia/Ho_Chi_Minh',
  'Asia/Ulan_Bator': 'Asia/Ulaanbaatar',
  'Atlantic/Faeroe': 'Atlantic/Faroe',
  'Australia/Currie': 'Australia/Hobart',
  'Europe/Kiev': 'Europe/Kyiv',
  'Europe/Uzhgorod': 'Europe/Kyiv',
  'Europe/Zaporozhye': 'Europe/Kyiv',
  'Pacific/Enderbury': 'Pacific/Kanton',
  'Pacific/Johnston': 'Pacific/Honolulu',
  'Pacific/Ponape': 'Pacific/Pohnpei',
  'Pacific/Truk': 'Pacific/Chuuk',
};

/** Current IANA name of a zone (legacy aliases from the browser mapped, see LEGACY_ZONES). */
export function canonicalZone(tz: string): string {
  const mapped = LEGACY_ZONES[tz];
  return mapped && isValidTimeZone(mapped) ? mapped : tz;
}

export function deviceTimeZone(): string {
  try {
    const tz = canonicalZone(Intl.DateTimeFormat().resolvedOptions().timeZone);
    return isValidTimeZone(tz) ? tz : 'UTC';
  } catch {
    return 'UTC';
  }
}

let zones: string[] | null = null;

/** IANA zones known to this browser (+ UTC), alphabetical. */
export function timeZoneOptions(): string[] {
  if (!zones) {
    let list: string[] = [];
    try {
      list = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.('timeZone') ?? [];
    } catch {
      list = [];
    }
    zones = [...new Set([...list.map(canonicalZone), 'UTC', deviceTimeZone()])].filter(isValidTimeZone).sort();
  }
  return zones;
}

/** "Asia/Ho_Chi_Minh" -> "Ho Chi Minh" (the IANA city; Intl has no localized city names). */
export function zoneCity(tz: string): string {
  const parts = tz.split('/');
  return (parts.at(-1) ?? tz).replace(/_/g, ' ');
}

/** "Indochina-Zeit" (timeZoneName longGeneric in the UI language), or null when Intl has none. */
export function zoneGenericName(tz: string, locale: LocaleCode): string | null {
  try {
    const parts = new Intl.DateTimeFormat(intlLocale(locale), {
      timeZone: tz,
      timeZoneName: 'longGeneric',
    }).formatToParts(new Date());
    const name = parts.find((p) => p.type === 'timeZoneName')?.value ?? '';
    // Zones without a name come back as "GMT+07:00" (the offset is shown separately).
    return name && !/^(GMT|UTC)([+-−]|$)/.test(name) ? name : null;
  } catch {
    return null;
  }
}

/** "Ho Chi Minh · Indochina-Zeit" for pickers and labels (UTC stays "UTC"). */
export function zoneLabel(tz: string, locale: LocaleCode): string {
  if (!tz.includes('/')) return tz;
  const generic = zoneGenericName(tz, locale);
  const city = zoneCity(tz);
  return generic && generic !== city ? `${city} · ${generic}` : city;
}

export interface ZoneChoice {
  tz: string;
  label: string;
  offset: string;
}

const zoneChoiceCache = new Map<LocaleCode, ZoneChoice[]>();

/** Every zone of timeZoneOptions() with its localized label, sorted by that label. */
export function zoneChoices(locale: LocaleCode): ZoneChoice[] {
  let list = zoneChoiceCache.get(locale);
  if (!list) {
    const collator = new Intl.Collator(intlLocale(locale));
    list = timeZoneOptions()
      .map((tz) => ({ tz, label: zoneLabel(tz, locale), offset: zoneOffset(tz) }))
      .sort((a, b) => collator.compare(a.label, b.label) || collator.compare(a.tz, b.tz));
    zoneChoiceCache.set(locale, list);
  }
  return list;
}

/** Current UTC offset of a zone as "+07:00". */
export function zoneOffset(tz: string, at: Date = new Date()): string {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'longOffset' }).formatToParts(at);
    const name = parts.find((p) => p.type === 'timeZoneName')?.value ?? '';
    const m = /GMT([+-]\d{2}:\d{2})?/.exec(name);
    return m?.[1] ?? '+00:00';
  } catch {
    return '';
  }
}

const LOCAL_INPUT_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

/** "2026-11-15T19:30" wall-clock time in `tz` -> ISO UTC instant (null for invalid input). */
export function zonedTimeToUtc(local: string, tz: string): string | null {
  const m = LOCAL_INPUT_RE.exec(local);
  if (!m || !isValidTimeZone(tz)) return null;
  const asUtc = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]));
  if (Number.isNaN(asUtc)) return null;
  // Two passes settle the offset around DST changes.
  let guess = asUtc - utcOffsetMinutes(asUtc, tz) * 60_000;
  guess = asUtc - utcOffsetMinutes(guess, tz) * 60_000;
  return new Date(guess).toISOString();
}

/** ISO UTC instant -> "YYYY-MM-DDTHH:mm" in `tz` (value of a datetime-local input). */
export function utcToZonedInput(iso: string, tz: string): string {
  return `${localDateFor(iso, tz)}T${localTimeFor(iso, tz)}`;
}
