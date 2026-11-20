/**
 * Leaving an editor with unsaved changes (tab bar, back link, next day, browser back): a sheet
 * asks "Save / Discard / Keep editing". Closing or reloading the page asks the browser's own
 * question. (The edit is autosaved as a draft either way, so nothing is lost.)
 */
import { Trans, useLingui } from '@lingui/react/macro';
import { useBlocker } from '@tanstack/react-router';
import { Button, Dialog } from './ui';

const block = () => true;

export function UnsavedChangesGuard({
  dirty,
  canSave = true,
  onSave,
  onDiscard,
}: {
  dirty: boolean;
  canSave?: boolean;
  onSave: () => void;
  onDiscard: () => void;
}) {
  const { t } = useLingui();
  // Registered only while dirty (the blocker re-registers when its options change).
  const blocker = useBlocker({ shouldBlockFn: block, enableBeforeUnload: true, disabled: !dirty, withResolver: true });
  const open = blocker.status === 'blocked';
  return (
    <Dialog
      open={open}
      onClose={() => blocker.reset?.()}
      closeLabel={t`Close`}
      title={<Trans>Save your changes?</Trans>}
      description={<Trans>You changed this but did not save it yet.</Trans>}
      footer={
        <>
          <Button variant="ghost" onClick={() => blocker.reset?.()}>
            <Trans>Keep editing</Trans>
          </Button>
          <Button
            variant="secondary"
            onClick={() => {
              onDiscard();
              blocker.proceed?.();
            }}
          >
            <Trans>Discard</Trans>
          </Button>
          <Button
            disabled={!canSave}
            onClick={() => {
              onSave();
              blocker.proceed?.();
            }}
          >
            <Trans>Save</Trans>
          </Button>
        </>
      }
    />
  );
}
