/**
 * Literal .env parser for dev scripts and the publisher CLI. It never runs a shell: passwords in
 * .env may contain `$`, quotes, `#` or backticks, so `source .env` would corrupt them.
 *
 * Rules (deliberately small and predictable):
 * - One `KEY=value` per line; an optional leading `export ` is ignored.
 * - Blank lines and lines whose first non-blank character is `#` are skipped.
 * - KEY must match /^[A-Za-z_][A-Za-z0-9_]*$/; other lines are reported in `invalidLines`.
 * - The value is everything after the first `=`, with surrounding blanks trimmed. When it starts
 *   and ends with the same quote character (' or ") exactly one pair is removed. Nothing else is
 *   interpreted: no escapes, no `${VAR}` expansion, no inline comments (`a=b # c` keeps "b # c").
 * - A later duplicate key wins. A UTF-8 BOM is ignored; CRLF line endings are accepted.
 */
import { readFileSync } from 'node:fs';

const KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface DotenvResult {
  values: Record<string, string>;
  /** 1-based line numbers that were neither blank, comments nor KEY=value. */
  invalidLines: number[];
}

export function parseDotenvDetailed(text: string): DotenvResult {
  const values: Record<string, string> = {};
  const invalidLines: number[] = [];
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  lines.forEach((raw, i) => {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) return;
    const body = line.startsWith('export ') ? line.slice('export '.length).trimStart() : line;
    const eq = body.indexOf('=');
    if (eq <= 0) {
      invalidLines.push(i + 1);
      return;
    }
    const key = body.slice(0, eq).trim();
    if (!KEY.test(key)) {
      invalidLines.push(i + 1);
      return;
    }
    values[key] = unquote(body.slice(eq + 1).trim());
  });
  return { values, invalidLines };
}

/** KEY -> value map of a .env text (see the module comment for the exact rules). */
export function parseDotenv(text: string): Record<string, string> {
  return parseDotenvDetailed(text).values;
}

/** Reads and parses a .env file (throws when it cannot be read). */
export function readDotenvFile(path: string): Record<string, string> {
  return parseDotenv(readFileSync(path, 'utf8'));
}

/**
 * Environment for scripts: values from the .env file, overridden by variables that are set in the
 * real environment (non-empty), so `FOO=x node script.ts --env-file .env` still wins.
 */
export function mergeEnv(
  fileValues: Record<string, string>,
  env: Record<string, string | undefined> = process.env,
): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = { ...fileValues };
  for (const [k, v] of Object.entries(env)) {
    if (v !== undefined && v !== '') out[k] = v;
  }
  return out;
}

function unquote(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    if ((first === '"' || first === "'") && value.endsWith(first)) return value.slice(1, -1);
  }
  return value;
}
