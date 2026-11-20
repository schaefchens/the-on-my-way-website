/**
 * "Install as an app": on Android/Chromium the browser's own install prompt (deferred in
 * pwa.ts), on iPhone/iPad a short sheet (Safari: Share -> Add to Home Screen), nothing when the
 * app already runs installed or the browser cannot install it. The Home card can be dismissed;
 * Settings keeps the offer.
 */
import { Trans, useLingui } from '@lingui/react/macro';
import { useState } from 'react';
import { localStore, useStore } from '../lib/store';
import { installPromptStore, isIos, isStandalone } from '../pwa';
import { CloseIcon, InstallIcon, PlusIcon, ShareIcon } from './icons';
import { Button, Card, Dialog, IconButton } from './ui';

const DISMISSED_KEY = 'omw.admin.installDismissed';

type InstallKind = 'prompt' | 'ios' | null;

function useInstallKind(): InstallKind {
  const prompt = useStore(installPromptStore);
  if (isStandalone()) return null;
  if (prompt) return 'prompt';
  return isIos() ? 'ios' : null;
}

function IosSteps() {
  return (
    <ol className="space-y-3 text-sm">
      <li className="flex items-start gap-3">
        <span className="grid size-8 shrink-0 place-items-center rounded-pill bg-blush font-bold text-accent-strong">
          1
        </span>
        <span className="pt-1">
          <Trans>
            Open this page in Safari and tap <ShareIcon className="inline size-5 align-text-bottom text-accent" />{' '}
            <strong>Share</strong>.
          </Trans>
        </span>
      </li>
      <li className="flex items-start gap-3">
        <span className="grid size-8 shrink-0 place-items-center rounded-pill bg-blush font-bold text-accent-strong">
          2
        </span>
        <span className="pt-1">
          <Trans>
            Scroll down and tap <PlusIcon className="inline size-5 align-text-bottom text-accent" />{' '}
            <strong>Add to Home Screen</strong>.
          </Trans>
        </span>
      </li>
      <li className="flex items-start gap-3">
        <span className="grid size-8 shrink-0 place-items-center rounded-pill bg-blush font-bold text-accent-strong">
          3
        </span>
        <span className="pt-1">
          <Trans>
            Tap <strong>Add</strong>. The journal now opens from its own icon, full screen.
          </Trans>
        </span>
      </li>
    </ol>
  );
}

/** The button that installs (Chromium) or explains how (iOS). */
export function InstallAction({ className }: { className?: string }) {
  const { t } = useLingui();
  const kind = useInstallKind();
  const prompt = useStore(installPromptStore);
  const [steps, setSteps] = useState(false);
  if (!kind) return null;
  return (
    <>
      <Button
        icon={InstallIcon}
        className={className}
        onClick={async () => {
          if (kind === 'ios' || !prompt) {
            setSteps(true);
            return;
          }
          await prompt.prompt();
          // A prompt can be used once: accepted or not, it is gone.
          await prompt.userChoice.catch(() => undefined);
          installPromptStore.set(null);
        }}
      >
        <Trans>Install as an app</Trans>
      </Button>
      <Dialog
        open={steps}
        onClose={() => setSteps(false)}
        closeLabel={t`Close`}
        title={<Trans>Add to your home screen</Trans>}
        description={<Trans>Then the journal opens like an app, without the browser around it.</Trans>}
        footer={
          <Button variant="secondary" onClick={() => setSteps(false)}>
            <Trans>Got it</Trans>
          </Button>
        }
      >
        <IosSteps />
      </Dialog>
    </>
  );
}

/** Dismissible card on Home. */
export function InstallCard() {
  const { t } = useLingui();
  const kind = useInstallKind();
  const [dismissed, setDismissed] = useState(() => localStore.read<boolean>(DISMISSED_KEY, false));
  if (!kind || dismissed) return null;
  return (
    <Card className="flex items-start gap-4 p-4 sm:col-span-2 sm:p-5 lg:col-span-3">
      <span className="grid size-12 shrink-0 place-items-center rounded-pill bg-lilac text-violet">
        <InstallIcon className="size-6" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="display-soft text-lg leading-snug font-semibold">
          <Trans>Keep the journal on your home screen</Trans>
        </p>
        <p className="mt-0.5 text-sm text-muted">
          <Trans>One tap to write, full screen, and it works offline.</Trans>
        </p>
        <InstallAction className="mt-3" />
      </div>
      <IconButton
        label={t`Not now`}
        icon={CloseIcon}
        className="-me-2 -mt-1"
        onClick={() => {
          localStore.write(DISMISSED_KEY, true);
          setDismissed(true);
        }}
      />
    </Card>
  );
}
