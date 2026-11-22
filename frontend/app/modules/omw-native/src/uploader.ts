import { NativeUnavailableError, NO_SUBSCRIPTION, nativeModule } from './native';
import {
  DEFAULT_UPLOAD_SETTINGS,
  type Subscription,
  type UploaderConfig,
  type UploadJob,
  type UploadNowOptions,
  type UploadProgressEvent,
  type UploadSettings,
  type UploadStatus,
} from './types';

interface Native {
  configure(config: UploaderConfig): Promise<void>;
  getSettings(): Promise<UploadSettings>;
  setSettings(patch: Partial<UploadSettings>): Promise<UploadSettings>;
  enqueue(job: UploadJob): Promise<void>;
  cancel(entryId: string): Promise<boolean>;
  withdraw(entryId: string): Promise<boolean>;
  uploadNow(options: UploadNowOptions): Promise<number>;
  status(entryId: string | null): Promise<UploadStatus[]>;
  addListener(eventName: 'onUploadProgress', listener: (event: UploadProgressEvent) => void): Subscription;
  addListener(eventName: 'onUploadStateChange', listener: (event: UploadStatus) => void): Subscription;
}

const native = () => nativeModule<Native>('OmwUploader');

function required(what: string): Native {
  const n = native();
  if (!n) throw new NativeUnavailableError(what);
  return n;
}

/**
 * The native background uploader (create -> tus PATCH chunks -> commit), independent of JS once a
 * job is enqueued: a UIDT job on Android 14+, WorkManager below. Settings and the API base live
 * natively so the uploader decides and sends without JS (see API.md).
 */
export const Uploader = {
  /**
   * Sets the API base the uploader sends to (the build's `extra.apiBaseUrl`). Call it at app
   * start, before pairing; it is stored natively. https only, except http://127.0.0.1 in
   * development. Rejects anything else.
   */
  async configure(config: UploaderConfig): Promise<void> {
    await required('Uploader.configure').configure({ apiBaseUrl: config.apiBaseUrl });
  },
  async getSettings(): Promise<UploadSettings> {
    const n = native();
    return n ? n.getSettings() : { ...DEFAULT_UPLOAD_SETTINGS, roamingAllowedSims: [] };
  },
  /** Applies the given keys and resolves the full, stored settings. */
  async setSettings(patch: Partial<UploadSettings>): Promise<UploadSettings> {
    return required('Uploader.setSettings').setSettings(patch);
  },
  /**
   * Persists the job; it survives process death and reboots. Idempotent per entryId; the same entry
   * again restarts a job that failed for good ("Try again"). Rejects an id that was withdrawn.
   */
  async enqueue(job: UploadJob): Promise<void> {
    await required('Uploader.enqueue').enqueue(job);
  },
  /** Stops and forgets the job (no server-side withdraw: use withdraw() for a shared moment). */
  cancel: async (entryId: string): Promise<boolean> => (await native()?.cancel(entryId)) ?? false,
  /**
   * She took a shared moment back (Undo, Remove): stops and forgets its job and records the
   * withdrawal natively and durably. The uploader then sends DELETE /app/entries/{entryId} before
   * any upload (paced and retried like uploads, also without the app) unless the API provably never
   * got the entry. The id can never be enqueued again; a moment shared again needs a new id.
   * Resolves whether a DELETE is owed. Idempotent.
   */
  async withdraw(entryId: string): Promise<boolean> {
    return required('Uploader.withdraw').withdraw(entryId);
  },
  /** "Upload now": lifts the manual block for one or all jobs; resolves how many it affected. */
  uploadNow: async (options: UploadNowOptions = {}): Promise<number> => (await native()?.uploadNow(options)) ?? 0,
  /** Status of one job, or of all jobs. */
  status: async (entryId?: string): Promise<UploadStatus[]> => (await native()?.status(entryId ?? null)) ?? [],
  addProgressListener(listener: (event: UploadProgressEvent) => void): Subscription {
    return native()?.addListener('onUploadProgress', listener) ?? NO_SUBSCRIPTION;
  },
  addStateListener(listener: (event: UploadStatus) => void): Subscription {
    return native()?.addListener('onUploadStateChange', listener) ?? NO_SUBSCRIPTION;
  },
};
