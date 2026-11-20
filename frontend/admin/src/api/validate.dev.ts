// Dev-only response checks against the shared contracts (dynamically imported; not in prod chunks).
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
} as const;

export function checkResponse(name: keyof typeof SCHEMAS, data: unknown, what: string): void {
  const result = SCHEMAS[name].safeParse(data);
  if (!result.success) {
    console.error(
      `${what}: response does not match @omw/contracts/api ${name}:\n${z.prettifyError(result.error)}`,
      data,
    );
  }
}
