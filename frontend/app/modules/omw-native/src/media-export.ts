import { NativeUnavailableError, NO_SUBSCRIPTION, nativeModule } from './native';
import type { ExportProgressEvent, ExportResult, PhotoExportRequest, Subscription, VideoExportRequest } from './types';

interface Native {
  exportVideo(request: VideoExportRequest): Promise<ExportResult>;
  exportPhoto(request: PhotoExportRequest): Promise<ExportResult>;
  cancel(jobId: string): Promise<boolean>;
  addListener(eventName: 'onExportProgress', listener: (event: ExportProgressEvent) => void): Subscription;
}

const native = () => nativeModule<Native>('OmwMediaExport');

function required(what: string): Native {
  const n = native();
  if (!n) throw new NativeUnavailableError(what);
  return n;
}

/**
 * On-device export of the published artifact, without metadata or location (API.md): videos with
 * Media3 Transformer in a foreground service (trim ≤ 60 s, mute, H.264/AAC, SDR, ≤ 1920 px,
 * ≤ 30 fps), photos as EXIF-free JPEG (orientation baked in, ≤ 2880 × 1600). Results carry the
 * sha256 for AppFile. Failures reject with an ExportErrorCode in error.code.
 */
export const MediaExport = {
  async exportVideo(request: VideoExportRequest): Promise<ExportResult> {
    return required('MediaExport.exportVideo').exportVideo(request);
  },
  async exportPhoto(request: PhotoExportRequest): Promise<ExportResult> {
    return required('MediaExport.exportPhoto').exportPhoto(request);
  },
  /** Resolves false when the job was unknown or already finished. */
  cancel: async (jobId: string): Promise<boolean> => (await native()?.cancel(jobId)) ?? false,
  addProgressListener(listener: (event: ExportProgressEvent) => void): Subscription {
    return native()?.addListener('onExportProgress', listener) ?? NO_SUBSCRIPTION;
  },
};
