import { describe, expect, it, jest } from '@jest/globals';
import type { AppEntry } from '@omw/contracts/app';
import { fireEvent, screen, within } from '@testing-library/react-native';
import { newDraft, type OutboxManifest, transition } from '../src/core/outbox-machine';
import { AS_USUAL, PublishSheet } from '../src/ui/publish-sheet';
import { QueueSheet } from '../src/ui/queue-sheet';
import { HOTSPOT, LATER, MOBILE, NOW, PHOTO_FILES, SETTINGS, status } from './fixtures';
import { fakeOutbox, renderWithApp } from './render';

jest.mock('expo-router', () => ({ useRouter: () => ({ push: jest.fn(), back: jest.fn() }) }));

const ENTRY = {} as AppEntry;

function entry(id: string, ...events: Parameters<typeof transition>[1][]): OutboxManifest {
  const draft = newDraft({
    entryId: id,
    kind: 'photo',
    origin: 'camera',
    now: NOW,
    source: { name: 'source.jpg', mimetype: 'image/jpeg', bytes: 4_000_000 },
  });
  // The prepared entry carries the moment's own id (the machine refuses one for another id).
  const own = (e: Parameters<typeof transition>[1]) =>
    e.type === 'prepared' ? { ...e, entry: { ...e.entry, entryId: id } as AppEntry } : e;
  return events.reduce((m, e) => transition(m, own(e), LATER).next, draft);
}

const share = { type: 'share', at: NOW, tz: 'UTC' } as const;
const prepared = { type: 'prepared', files: PHOTO_FILES, entry: ENTRY } as const;
const enqueued = { type: 'enqueued' } as const;

describe('publish sheet', () => {
  it('says plainly that nothing goes public yet in archive-only mode', async () => {
    await renderWithApp(
      <PublishSheet
        open
        onClose={() => {}}
        count={2}
        choice={AS_USUAL}
        onChange={() => {}}
        onShare={() => {}}
        daySuggestions={[]}
      />,
    );
    expect(screen.getByTestId('publish-archive-note')).toBeTruthy();
    expect(screen.getByText(/nothing goes public yet/)).toBeTruthy();
    expect(screen.getByText('As usual, once publishing starts')).toBeTruthy();
    expect(screen.getByText('Share 2 moments')).toBeTruthy();
    // "Now" is v0.6 (fresh fingerprint): not offered.
    expect(screen.queryByText(/^Now/)).toBeNull();
  });

  it('words the delay once the site publishes', async () => {
    await renderWithApp(
      <PublishSheet
        open
        onClose={() => {}}
        count={1}
        choice={AS_USUAL}
        onChange={() => {}}
        onShare={() => {}}
        daySuggestions={[]}
      />,
      { settings: { hints: { archiveOnly: false, delayHours: 24, backendLastSeenAt: null, at: NOW } } },
    );
    expect(screen.queryByTestId('publish-archive-note')).toBeNull();
    expect(screen.getByText('As usual: appears in about 24 h')).toBeTruthy();
  });

  it('maps the three options and the per-entry upload override', async () => {
    const onChange = jest.fn();
    const onShare = jest.fn();
    await renderWithApp(
      <PublishSheet
        open
        onClose={() => {}}
        count={1}
        choice={AS_USUAL}
        onChange={onChange}
        onShare={onShare}
        daySuggestions={[{ day: '2026-11-17', label: 'Tue, Nov 17', count: 1 }]}
      />,
    );
    await fireEvent.press(screen.getByTestId('publish-option-pending'));
    expect(onChange).toHaveBeenLastCalledWith({ ...AS_USUAL, visibility: 'pending' });
    await fireEvent.press(screen.getByTestId('publish-option-hidden'));
    expect(onChange).toHaveBeenLastCalledWith({ ...AS_USUAL, visibility: 'hidden' });
    await fireEvent(screen.getByTestId('publish-upload-auto'), 'valueChange', false);
    expect(onChange).toHaveBeenLastCalledWith({ ...AS_USUAL, mode: 'manual' });
    await fireEvent(screen.getByTestId('day-2026-11-17'), 'valueChange', true);
    expect(onChange).toHaveBeenLastCalledWith({ ...AS_USUAL, acceptedDays: ['2026-11-17'] });
    expect(screen.getByText('This photo is from Tue, Nov 17')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('publish-share'));
    expect(onShare).toHaveBeenCalledTimes(1);
  });

  it('says "on Wi-Fi" when the upload will wait for it', async () => {
    await renderWithApp(
      <PublishSheet
        open
        onClose={() => {}}
        count={1}
        choice={AS_USUAL}
        onChange={() => {}}
        onShare={() => {}}
        daySuggestions={[]}
      />,
      { outbox: fakeOutbox([], { network: MOBILE }) },
    );
    expect(screen.getByText('Upload: automatically, on Wi-Fi')).toBeTruthy();
  });
});

describe('queue sheet', () => {
  it('lists every waiting moment with its status, oldest first', async () => {
    const entries = [
      entry('01JD4Z8W3K5V7X9Y1Z3B5C7D9A', share),
      entry('01JD4Z8W3K5V7X9Y1Z3B5C7D9B', share, prepared, enqueued, {
        type: 'upload',
        status: status({ entryId: '01JD4Z8W3K5V7X9Y1Z3B5C7D9B', state: 'uploading', sentBytes: 480_000 }),
      }),
      entry('01JD4Z8W3K5V7X9Y1Z3B5C7D9C', share, prepared, enqueued, {
        type: 'upload',
        status: status({ entryId: '01JD4Z8W3K5V7X9Y1Z3B5C7D9C', state: 'waiting', blockedBy: 'manual' }),
      }),
    ];
    await renderWithApp(<QueueSheet open onClose={() => {}} />, { outbox: fakeOutbox(entries) });
    const labels = screen.getAllByTestId('queue-row-status').map((n) => n.props.children);
    expect(labels).toEqual(['Preparing…', 'Uploading · 50 %', 'Ready to upload']);
    expect(screen.getByTestId('upload-now-all')).toBeTruthy();
  });

  it('“Upload now” on a hotspot asks once before using mobile data', async () => {
    const { Alert } = require('react-native') as typeof import('react-native');
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    const waiting = entry('01JD4Z8W3K5V7X9Y1Z3B5C7D9D', share, prepared, enqueued, {
      type: 'upload',
      status: status({ entryId: '01JD4Z8W3K5V7X9Y1Z3B5C7D9D', state: 'waiting', blockedBy: 'wifi_only' }),
    });
    const outbox = fakeOutbox([waiting], {
      network: HOTSPOT,
      statusContext: { settings: SETTINGS, network: HOTSPOT, paired: true, archiveOnly: true },
    });
    await renderWithApp(<QueueSheet open onClose={() => {}} />, { outbox });
    const row = screen.getByTestId('queue-row-01JD4Z8W3K5V7X9Y1Z3B5C7D9D');
    expect(within(row).getByText('Waiting for Wi-Fi')).toBeTruthy();
    expect(within(row).getByText(/this Wi-Fi is metered/)).toBeTruthy();
    await fireEvent.press(screen.getByTestId('upload-now-all'));
    expect(alert).toHaveBeenCalledTimes(1);
    expect(alert.mock.calls[0]?.[1]).toBe('Upload 960 kB anyway?');
    expect(outbox.uploadNow).not.toHaveBeenCalled();
    alert.mockRestore();
  });

  it('offers to connect while the phone is not paired', async () => {
    const entries = [entry('01JD4Z8W3K5V7X9Y1Z3B5C7D9E', share, prepared)];
    const outbox = fakeOutbox(entries, {
      paired: false,
      statusContext: { settings: SETTINGS, network: MOBILE, paired: false, archiveOnly: true },
    });
    await renderWithApp(<QueueSheet open onClose={() => {}} />, { outbox });
    expect(screen.getByTestId('queue-connect')).toBeTruthy();
    expect(screen.getByText('Waits on this phone')).toBeTruthy();
    expect(screen.getByText(/Connect this phone to your website first/)).toBeTruthy();
    expect(screen.queryByTestId('upload-now-all')).toBeNull();
  });

  it('a moment that needs her: “Try again”, or “Remove” after one question', async () => {
    const { Alert } = require('react-native') as typeof import('react-native');
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    const id = '01JD4Z8W3K5V7X9Y1Z3B5C7D9H';
    const failed = entry(id, share, prepared, enqueued, {
      type: 'upload',
      status: status({
        entryId: id,
        state: 'failed',
        error: { code: 'entry_conflict', message: 'x', permanent: true },
      }),
    });
    expect(failed.phase).toBe('failed');
    const outbox = fakeOutbox([failed]);
    await renderWithApp(<QueueSheet open onClose={() => {}} />, { outbox });
    const row = screen.getByTestId(`queue-row-${id}`);
    expect(within(row).getByText('Needs you')).toBeTruthy();
    await fireEvent.press(within(row).getByTestId('row-retry'));
    expect(outbox.retry).toHaveBeenCalledWith(id);
    await fireEvent.press(within(row).getByTestId('row-remove'));
    expect(alert).toHaveBeenCalledTimes(1);
    expect(alert.mock.calls[0]?.[0]).toBe('Remove this moment?');
    expect(outbox.discard).not.toHaveBeenCalled();
    const buttons = alert.mock.calls[0]?.[2] as { text: string; onPress?: () => void }[];
    buttons.find((b) => b.text === 'Remove')?.onPress?.();
    expect(outbox.discard).toHaveBeenCalledWith(id);
    alert.mockRestore();
  });

  it('is calm when nothing waits', async () => {
    await renderWithApp(<QueueSheet open onClose={() => {}} />);
    expect(screen.getByTestId('queue-empty')).toBeTruthy();
  });
});
