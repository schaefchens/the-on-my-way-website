/**
 * Root layout: the access boundary (spec-wave5 §6.3). While the access state is "ok" the routes
 * render; once the gate refused a request it shows the access screens instead (no route, no
 * query keeps running). In gate mode it also starts the visit pings (`me/hello`, src/access/hello).
 */
import { type ErrorComponentProps, Outlet } from '@tanstack/react-router';
import { useEffect } from 'react';
import { accessRuntime, onAccessEnded, useAccessState } from '../access/access';
import { AccessEndedScreen } from '../access/ended-screen';
import { loadFollowerName, startHello } from '../access/hello';
import { AccessEndedError } from '../data/fetch';
import { useSite } from '../site';
import { ErrorScreen } from './not-found';

function useHello(): void {
  const site = useSite();
  const gate = site.boot.access !== null;
  useEffect(() => {
    if (!gate) return;
    const { api, cookies, navigate } = accessRuntime();
    if (!api || !cookies) return;
    loadFollowerName();
    return startHello({ api, cookies, navigate });
  }, [gate]);
}

export function RootLayout() {
  const site = useSite();
  const state = useAccessState();
  useHello();
  if (state !== 'ok') return <AccessEndedScreen state={state} gate={site.boot.access !== null} />;
  return <Outlet />;
}

/** The router's error screen: a refused request goes to the access layer, anything else as before. */
export function RouteErrorScreen(props: ErrorComponentProps) {
  const site = useSite();
  const refused = props.error instanceof AccessEndedError;
  useEffect(() => {
    if (refused) void onAccessEnded();
  }, [refused]);
  if (refused) return <AccessEndedScreen state="checking" gate={site.boot.access !== null} />;
  return <ErrorScreen {...props} />;
}
