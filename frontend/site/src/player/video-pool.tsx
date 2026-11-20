/**
 * Pool of two <video muted playsinline> elements (plan C: "at most two videos in the player").
 * One slot plays the current video/GIF, the other preloads the next one (preload="metadata"),
 * so advancing to it swaps slots instead of creating elements. The elements are rendered once
 * by <VideoLayer> and driven imperatively; slides only claim them.
 */
import { createContext, type ReactNode, useContext, useMemo } from 'react';

interface Slot {
  el: HTMLVideoElement | null;
  key: string | null;
  src: string | null;
}

export interface VideoPool {
  /** Assigns `src` to a slot for the visible item and returns it (null before mount). */
  activate(
    key: string,
    src: string,
    opts: { loop: boolean; muted: boolean; fit: 'cover' | 'contain' },
  ): HTMLVideoElement | null;
  /** Hides and pauses the slot of `key` (if it is still the active one). */
  deactivate(key: string): void;
  /** Warms the spare slot with the next video (metadata only, or nothing in data-saver mode). */
  prepare(key: string, src: string, preload: 'metadata' | 'none'): void;
  /** Mute state for every slot (GIF slots stay muted). */
  setMuted(muted: boolean): void;
  /** Called by <VideoLayer> with its elements. */
  attach(index: 0 | 1, el: HTMLVideoElement | null): void;
  /** Stops both elements and drops their sources (aborts downloads). */
  dispose(): void;
}

export function createVideoPool(): VideoPool {
  const slots: [Slot, Slot] = [
    { el: null, key: null, src: null },
    { el: null, key: null, src: null },
  ];
  let activeKey: string | null = null;
  const loopKeys = new Set<string>();

  const assign = (slot: Slot, key: string, src: string, preload: 'metadata' | 'auto' | 'none') => {
    slot.key = key;
    if (slot.src !== src && slot.el) {
      slot.el.preload = preload;
      slot.el.src = src;
      slot.src = src;
    } else if (slot.el && preload !== 'none' && slot.el.preload !== 'auto') {
      slot.el.preload = preload;
    }
  };

  return {
    activate(key, src, { loop, muted, fit }) {
      let slot = slots.find((s) => s.key === key && s.src === src);
      if (!slot) slot = slots.find((s) => s.key !== activeKey) ?? slots[0];
      for (const other of slots) {
        if (other !== slot && other.el) {
          other.el.pause();
          other.el.dataset.active = 'false';
        }
      }
      assign(slot, key, src, 'auto');
      activeKey = key;
      if (loop) loopKeys.add(key);
      const el = slot.el;
      if (!el) return null;
      el.loop = loop;
      el.muted = loop ? true : muted;
      el.style.objectFit = fit;
      el.dataset.active = 'true';
      return el;
    },
    deactivate(key) {
      for (const slot of slots) {
        if (slot.key === key && slot.el) {
          slot.el.pause();
          slot.el.dataset.active = 'false';
          slot.el.dataset.ready = 'false';
        }
      }
      if (activeKey === key) activeKey = null;
    },
    prepare(key, src, preload) {
      if (slots.some((s) => s.key === key && s.src === src)) return;
      const spare = slots.find((s) => s.key !== activeKey);
      if (!spare || preload === 'none') return;
      assign(spare, key, src, preload);
    },
    setMuted(muted) {
      for (const slot of slots) {
        if (slot.el && !(slot.key && loopKeys.has(slot.key))) slot.el.muted = muted;
      }
    },
    dispose() {
      for (const slot of slots) {
        if (slot.el) {
          slot.el.pause();
          slot.el.removeAttribute('src');
          slot.el.load();
        }
        slot.key = null;
        slot.src = null;
      }
      activeKey = null;
    },
    attach(index, el) {
      const slot = slots[index];
      slot.el = el;
      if (el && slot.src && el.src !== slot.src) el.src = slot.src;
    },
  };
}

const PoolContext = createContext<VideoPool | null>(null);

export function VideoPoolProvider({ pool, children }: { pool: VideoPool; children: ReactNode }) {
  return <PoolContext.Provider value={pool}>{children}</PoolContext.Provider>;
}

export function useVideoPool(): VideoPool {
  const pool = useContext(PoolContext);
  if (!pool) throw new Error('useVideoPool() outside <VideoPoolProvider>');
  return pool;
}

/** The two pooled elements, layered above the slides (only the active, ready one is visible). */
export function VideoLayer({ pool }: { pool: VideoPool }) {
  const [attach0, attach1] = useMemo(
    () => [(el: HTMLVideoElement | null) => pool.attach(0, el), (el: HTMLVideoElement | null) => pool.attach(1, el)],
    [pool],
  );
  const className =
    'pointer-events-none absolute inset-0 size-full object-cover opacity-0 transition-opacity duration-200 data-[active=true]:data-[ready=true]:opacity-100';
  return (
    <>
      <video ref={attach0} className={className} muted playsInline preload="none" aria-hidden="true" tabIndex={-1} />
      <video ref={attach1} className={className} muted playsInline preload="none" aria-hidden="true" tabIndex={-1} />
    </>
  );
}
