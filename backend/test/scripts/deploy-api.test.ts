/**
 * scripts/deploy-api.ts (spec-wave5 WP5): the generated admin password is long enough for the
 * API's 12-character minimum, and --set-env-file merges only the access keys into the remote .env
 * without ever needing to show a value. Importing the script deploys nothing.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PASSWORD_MIN_LENGTH } from '@omw/contracts/api';
import { describe, expect, it } from 'vitest';
import {
  ACCESS_ENV_KEYS,
  describeEnvChanges,
  generateAdminPassword,
  mergeEnvText,
  parseArgs,
  parseDotEnv,
  readAccessEnv,
} from '../../../scripts/deploy-api.js';
import { REPO_ROOT } from '../../src/paths.js';

describe('--reset-admin-password', () => {
  it('generates 32-character base64url passwords, never shorter than the API minimum', () => {
    expect(PASSWORD_MIN_LENGTH).toBe(12);
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const password = generateAdminPassword();
      expect(password).toMatch(/^[A-Za-z0-9_-]{32}$/);
      expect(password.length).toBeGreaterThanOrEqual(PASSWORD_MIN_LENGTH);
      seen.add(password);
    }
    expect(seen.size).toBe(200);
  });

  it('matches the PHP minimum (Passwords::MIN_LENGTH)', () => {
    const php = readFileSync(join(REPO_ROOT, 'api/src/Domain/Auth/Passwords.php'), 'utf8');
    expect(php).toMatch(new RegExp(`MIN_LENGTH\\s*=\\s*${PASSWORD_MIN_LENGTH};`));
  });
});

describe('--set-env-file', () => {
  it('is parsed as an absolute path and excluded from --checks-only', () => {
    expect(parseArgs(['--set-env-file=access.env']).setEnvFile).toBe(join(process.cwd(), 'access.env'));
    expect(parseArgs([]).setEnvFile).toBeNull();
    expect(() => parseArgs(['--set-env-file='])).toThrow(/needs a file name/);
    expect(() => parseArgs(['--checks-only', '--set-env-file=a.env'])).toThrow(/does not deploy/);
  });

  it('knows exactly the keys of AccessConfig::KEYS', () => {
    const php = readFileSync(join(REPO_ROOT, 'api/src/AccessConfig.php'), 'utf8');
    const block = /public const KEYS = \[([\s\S]*?)\];/.exec(php)?.[1] ?? '';
    const keys = [...block.matchAll(/'([A-Z0-9_]+)'/g)].map((m) => m[1]);
    expect([...ACCESS_ENV_KEYS].sort()).toEqual(keys.sort());
  });

  it('accepts only known ACCESS_* keys and literal values, naming the key but never the value', () => {
    expect(readAccessEnv('# P0b\nACCESS_STORE_MODE=direct\nACCESS_STORE_DIR=/usr/www/x/omw-store/site1\n')).toEqual({
      ACCESS_STORE_MODE: 'direct',
      ACCESS_STORE_DIR: '/usr/www/x/omw-store/site1',
    });
    expect(() => readAccessEnv('\n# nothing\n')).toThrow(/sets no key/);
    expect(() => readAccessEnv('SITE_ORIGIN=https://x.example\n')).toThrow(/only ACCESS_\* keys.*SITE_ORIGIN/);
    expect(() => readAccessEnv('ACCESS_STOR_MODE=direct\n')).toThrow(/unknown key ACCESS_STOR_MODE/);
    for (const bad of ["pa'ss", 'a\\b', 'tab\there', 'x"y']) {
      try {
        readAccessEnv(`ACCESS_STORE_SFTP_PASSWORD="${bad}"\nACCESS_STORE_MODE=sftp\n`.replace(`"${bad}"`, bad));
        expect.unreachable(`accepted ${JSON.stringify(bad)}`);
      } catch (err) {
        expect(String(err)).toContain('ACCESS_STORE_SFTP_PASSWORD');
        expect(String(err)).not.toContain(bad);
      }
    }
  });

  it('replaces existing lines, appends new keys, keeps everything else byte for byte', () => {
    const remote = [
      '# On My Way API (created by scripts/deploy-api.ts on the first deploy; never overwritten).',
      'APP_ENV=production',
      'SITE_ORIGIN=https://site.example.org',
      'ACCESS_STORE_MODE=none',
      'CRON_KEY=abc',
      'export ACCESS_STORE_MODE=none',
      'MAIL_DSN=',
      '',
    ].join('\n');
    const { text, changes } = mergeEnvText(
      remote,
      { ACCESS_STORE_MODE: 'direct', ACCESS_STORE_DIR: '/usr/www/x/omw-store/site1', ACCESS_GATE_PROBE: 'true' },
      '# merged',
    );
    expect(text).toBe(
      [
        '# On My Way API (created by scripts/deploy-api.ts on the first deploy; never overwritten).',
        'APP_ENV=production',
        'SITE_ORIGIN=https://site.example.org',
        'CRON_KEY=abc',
        'ACCESS_STORE_MODE=direct',
        'MAIL_DSN=',
        '',
        '# merged',
        'ACCESS_STORE_DIR=/usr/www/x/omw-store/site1',
        'ACCESS_GATE_PROBE=true',
        '',
      ].join('\n'),
    );
    expect(changes).toEqual([
      { key: 'ACCESS_STORE_MODE', change: 'changed' },
      { key: 'ACCESS_STORE_DIR', change: 'new' },
      { key: 'ACCESS_GATE_PROBE', change: 'new' },
    ]);
    expect(describeEnvChanges(changes)).toBe(
      'ACCESS_STORE_MODE (changed), ACCESS_STORE_DIR (new), ACCESS_GATE_PROBE (new)',
    );
    expect(describeEnvChanges(changes)).not.toContain('/usr/www');
    // The result parses back to the merged values; a second merge changes nothing.
    expect(parseDotEnv(text)).toMatchObject({ APP_ENV: 'production', ACCESS_STORE_MODE: 'direct', CRON_KEY: 'abc' });
    const again = mergeEnvText(text, { ACCESS_STORE_MODE: 'direct' }, '# merged');
    expect(again.text).toBe(text);
    expect(again.changes).toEqual([{ key: 'ACCESS_STORE_MODE', change: 'unchanged' }]);
  });

  it('quotes values that are not plain tokens (phpdotenv reads single quotes literally)', () => {
    const { text } = mergeEnvText('', { ACCESS_STORE_SFTP_PASSWORD: 'a b$c#d' }, '# m');
    expect(text).toBe("# m\nACCESS_STORE_SFTP_PASSWORD='a b$c#d'\n");
    expect(parseDotEnv(text).ACCESS_STORE_SFTP_PASSWORD).toBe('a b$c#d');
  });
});
