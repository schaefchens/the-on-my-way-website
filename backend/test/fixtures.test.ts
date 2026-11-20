/**
 * Loads the synthetic fixtures (`pnpm fixtures`) into an in-memory store: every meta.json must
 * parse, and the derived local dates must match fixtures/generated/index.json. Skipped (with a
 * visible "skipped" count) when the fixtures have not been generated yet.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ChangesResponse } from '@omw/contracts/api';
import { InboxMeta, RevokeRecord } from '@omw/contracts/wa';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../src/paths.js';
import { newCaptureFromInbox, Store } from '../src/store/index.js';

const dir = join(REPO_ROOT, 'fixtures', 'generated');
const present = existsSync(join(dir, 'index.json'));

interface IndexEntry {
  msgId: string;
  kind: string;
  tz: string;
  localDate: string;
  source: string;
  download: string;
  revokedAt: string | null;
}

describe.skipIf(!present)('generated fixtures', () => {
  it('ingest into the store with the expected local dates, revokes and owner content', async () => {
    const index = JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8')) as { statuses: IndexEntry[] };
    const store = Store.memory();
    const inbox = join(dir, 'inbox');
    const msgDirs = readdirSync(inbox).filter((d) => d !== '_revokes');
    expect(msgDirs.length).toBe(index.statuses.length);

    // Revokes first: a startup rescan may see a revoke before its status (parked, applied on insert).
    for (const file of readdirSync(join(inbox, '_revokes'))) {
      const revoke = RevokeRecord.parse(JSON.parse(readFileSync(join(inbox, '_revokes', file), 'utf8')));
      expect(store.captures.applyRevoke(revoke.msgId, revoke.at)).toBe('pending');
    }
    for (const entry of index.statuses) {
      const meta = InboxMeta.parse(JSON.parse(readFileSync(join(inbox, entry.msgId, 'meta.json'), 'utf8')));
      if (meta.download.file) expect(existsSync(join(inbox, entry.msgId, meta.download.file))).toBe(true);
      else expect(meta.download.state).not.toBe('ok');
      const { inserted, row } = store.captures.insert(await newCaptureFromInbox(meta, entry.tz));
      expect(inserted).toBe(true);
      expect(row.localDate).toBe(entry.localDate);
      expect(row.kind).toBe(entry.kind);
      expect(row.downloadState).toBe(entry.download);
    }
    expect(store.captures.pendingRevokes()).toEqual([]);
    expect(store.captures.list().filter((c) => c.revokedAt).length).toBe(
      index.statuses.filter((s) => s.revokedAt).length,
    );
    // Edge cases are present: a pending download, a permanently lost one, live and history sources.
    expect(store.captures.countByState()).toMatchObject({ awaiting_media: 1, media_lost: 1 });
    expect(new Set(index.statuses.map((s) => s.source))).toEqual(new Set(['fixture', 'live', 'history']));

    const owner = JSON.parse(readFileSync(join(dir, 'owner.json'), 'utf8')) as { changes: unknown };
    const summary = store.owner.applyChanges(ChangesResponse.parse(owner.changes));
    expect(summary).toMatchObject({ skipped: 0, ignored: 0, quarantined: 0 });
    expect(store.owner.settings()['timezone.current']).toBe('Asia/Ho_Chi_Minh');
    expect(store.owner.listPosts().map((p) => p.kind)).toEqual(['note', 'story', 'note']);
    expect(store.owner.getTrip('vietnam-2026')?.startDate).toBe('2026-11-14');
    store.close();
  });
});
