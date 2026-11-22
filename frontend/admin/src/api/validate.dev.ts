// Dev-only response checks against the shared contracts (dynamically imported; not in prod chunks).

import {
  AccessActionResult,
  AccessStatus,
  AdminFollower,
  FollowerCreated,
  FollowerDataExport,
  FollowerListResponse,
  OwnerNoticeList,
  PanicLinkCreated,
  PersonalLinkCreated,
  PrivacyState,
} from '@omw/contracts/access';
import {
  AdminDayDetail,
  AdminPost,
  AdminTrip,
  CaptureListItem,
  CaptureListResponse,
  DayListResponse,
  Health,
  Me,
  PostListResponse,
  Settings,
  StatusResponse,
  TokenCreated,
  TokenListResponse,
  TripListResponse,
} from '@omw/contracts/api';
import { z } from 'zod';

const SCHEMAS = {
  Me,
  Health,
  StatusResponse,
  CaptureListResponse,
  CaptureListItem,
  PostListResponse,
  AdminPost,
  DayListResponse,
  AdminDayDetail,
  TripListResponse,
  AdminTrip,
  Settings,
  TokenListResponse,
  TokenCreated,
  AccessStatus,
  AccessActionResult,
  FollowerListResponse,
  AdminFollower,
  FollowerCreated,
  PersonalLinkCreated,
  FollowerDataExport,
  PanicLinkCreated,
  PrivacyState,
  OwnerNoticeList,
} as const;

export function checkResponse(name: keyof typeof SCHEMAS, data: unknown, what: string): void {
  const result = SCHEMAS[name].safeParse(data);
  if (!result.success) {
    console.error(`${what}: response does not match @omw/contracts ${name}:\n${z.prettifyError(result.error)}`, data);
  }
}
