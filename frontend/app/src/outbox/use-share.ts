/**
 * "Share" for every maker (compose, text, voice): unlock if the app lock asks, write the choices
 * into the drafts, flip them to "preparing" durably, and only then: CONFIRM haptic, "Shared ·
 * Undo" (8 s) and back to Today, where the polaroid flies into the strip.
 */
import { useLingui } from '@lingui/react/macro';
import { useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import type { OutboxChoice } from '../core/outbox-machine';
import { useLock } from '../state/lock';
import { feedback } from '../ui/haptics';
import type { PublishChoice } from '../ui/publish-sheet';
import { useToast } from '../ui/toast';
import { useOutbox } from './outbox';

/** The publish sheet's choice for one entry (its own day only when she said yes to that day). */
export function choiceFor(choice: PublishChoice, takenOn: string | null | undefined): OutboxChoice {
  return {
    ...(choice.visibility ? { visibility: choice.visibility } : {}),
    ...(choice.mode ? { mode: choice.mode } : {}),
    ...(takenOn && choice.acceptedDays.includes(takenOn) ? { localDate: takenOn } : {}),
  };
}

export function useShare() {
  const outbox = useOutbox();
  const lock = useLock();
  const toast = useToast();
  const router = useRouter();
  const { t } = useLingui();
  const [sharing, setSharing] = useState(false);

  const share = useCallback(
    async (ids: readonly string[], choice: PublishChoice): Promise<boolean> => {
      if (sharing || ids.length === 0) return false;
      if (!(await lock.requireUnlock(t`Unlock to share`))) return false;
      setSharing(true);
      try {
        const choices = Object.fromEntries(ids.map((id) => [id, choiceFor(choice, outbox.get(id)?.source?.takenOn)]));
        await outbox.share(ids, choices);
        feedback.confirm();
        toast.show({
          message: ids.length === 1 ? t`Shared` : t`${ids.length} moments shared`,
          icon: 'Check',
          action: {
            label: t`Undo`,
            testID: 'toast-undo',
            onPress: () => {
              feedback.undo();
              void outbox.undo(ids);
            },
          },
        });
        if (router.canDismiss()) router.dismissTo('/');
        else router.replace('/');
        return true;
      } catch (e) {
        // Development builds only: why (the drafts stay as they are).
        if (__DEV__) console.warn(`Share failed: ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`);
        feedback.reject();
        toast.show({ message: t`That didn’t work. It’s still here as a draft.`, icon: 'Alert' });
        return false;
      } finally {
        setSharing(false);
      }
    },
    [sharing, lock, outbox, toast, router, t],
  );

  return { share, sharing };
}
