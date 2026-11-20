/** Translated labels for contract enums (Lingui message descriptors, rendered with i18n._). */
import type { MessageDescriptor } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import type { CaptureKind, Visibility } from '@omw/contracts';
import type { PublishMode } from '@omw/contracts/api';
import type { WaState } from '@omw/contracts/wa';

export const VISIBILITY_LABEL: Record<Visibility, MessageDescriptor> = {
  public: msg`Public`,
  hidden: msg`Hidden`,
  pending: msg`Waiting`,
};

export const KIND_LABEL: Record<CaptureKind | 'note' | 'story', MessageDescriptor> = {
  photo: msg`Photo`,
  video: msg`Video`,
  gif: msg`GIF`,
  voice: msg`Voice message`,
  text: msg`Text status`,
  unsupported: msg`Unsupported`,
  note: msg`Note`,
  story: msg`Story`,
};

export const WA_STATE_LABEL: Record<WaState, MessageDescriptor> = {
  open: msg`Connected`,
  connecting: msg`Connecting…`,
  pairing: msg`Pairing…`,
  qr: msg`Waiting for QR scan`,
  closed: msg`Disconnected`,
  logged_out: msg`Logged out`,
  stream_replaced: msg`Replaced by another session`,
  banned: msg`Temporarily banned`,
  error: msg`Error`,
};

export const PUBLISH_MODE_LABEL: Record<PublishMode, MessageDescriptor> = {
  instant: msg`Instantly`,
  delayed: msg`Delayed`,
  review: msg`After review`,
};

/** Field names of owner entities (conflict dialog). */
export const FIELD_LABEL: Record<string, MessageDescriptor> = {
  description: msg`Description`,
  visibility: msg`Visibility`,
  localDateOverride: msg`Day`,
  origLocale: msg`Original language`,
  title: msg`Title`,
  summary: msg`Summary`,
  placeName: msg`Place`,
  countryCode: msg`Country`,
  lat: msg`Latitude`,
  lng: msg`Longitude`,
  coverSourceKey: msg`Cover`,
  tz: msg`Time zone`,
  content: msg`Text`,
  occurredAt: msg`Time`,
  startDate: msg`Start`,
  endDate: msg`End`,
};
