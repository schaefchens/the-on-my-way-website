/**
 * Client ULIDs for app entries (entryId, made at "Share"; app-plan §3.3). Crockford base32:
 * 10 chars of milliseconds + 16 chars of randomness. Monotonic inside one millisecond, so the
 * items of one batch keep their posting order when sorted by id.
 *
 * Framework-free: the random source is injected (expo-crypto in the app, a fixed one in tests).
 */
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const TIME_CHARS = 10;
const RANDOM_CHARS = 16;
const MAX_TIME = 2 ** 48 - 1;

export type RandomBytes = (count: number) => Uint8Array;

function encodeTime(ms: number): string {
  if (!Number.isInteger(ms) || ms < 0 || ms > MAX_TIME) throw new RangeError(`ULID time out of range: ${ms}`);
  let out = '';
  let n = ms;
  for (let i = 0; i < TIME_CHARS; i++) {
    out = (CROCKFORD[n % 32] ?? '0') + out;
    n = Math.floor(n / 32);
  }
  return out;
}

/** 80 random bits as 16 base32 digits (5 bits each). */
function randomDigits(random: RandomBytes): number[] {
  const bytes = random(10);
  const digits: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      digits.push((buffer >> bits) & 31);
    }
    buffer &= (1 << bits) - 1;
  }
  return digits.slice(0, RANDOM_CHARS);
}

/** Adds one to the base32 digits (the monotonic step); throws on overflow (2^80 ids in 1 ms). */
function increment(digits: number[]): number[] {
  const next = [...digits];
  for (let i = next.length - 1; i >= 0; i--) {
    const d = next[i] ?? 0;
    if (d < 31) {
      next[i] = d + 1;
      return next;
    }
    next[i] = 0;
  }
  throw new RangeError('ULID random overflow');
}

/** A monotonic ULID factory: ids made in the same millisecond still sort in creation order. */
export function monotonicUlid(random: RandomBytes): (now?: number) => string {
  let lastTime = -1;
  let lastDigits: number[] = [];
  return (now = Date.now()) => {
    const time = Math.max(now, lastTime);
    const digits = time === lastTime ? increment(lastDigits) : randomDigits(random);
    lastTime = time;
    lastDigits = digits;
    return encodeTime(time) + digits.map((d) => CROCKFORD[d] ?? '0').join('');
  };
}

/** Milliseconds encoded in a ULID (for sorting and "made at"). */
export function ulidTime(id: string): number {
  let n = 0;
  for (const ch of id.slice(0, TIME_CHARS)) {
    const v = CROCKFORD.indexOf(ch);
    if (v < 0) throw new RangeError(`Not a ULID: ${id}`);
    n = n * 32 + v;
  }
  return n;
}
