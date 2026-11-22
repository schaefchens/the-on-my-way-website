/**
 * Confirmation sheet for access actions (end access, remove a device, lock, delete a person).
 * Destructive sheets put the focus on "Cancel" first; `check` adds an unticked checkbox that
 * must be ticked before the (red) confirm button works (deliberate confirmation, D12).
 */
import { Trans, useLingui } from '@lingui/react/macro';
import { type ReactNode, useEffect, useId, useState } from 'react';
import { Button, Dialog, type Icon } from './ui';

export function ConfirmSheet({
  open,
  title,
  description,
  children,
  confirmLabel,
  confirmIcon,
  cancelLabel,
  danger = false,
  busy = false,
  check,
  onConfirm,
  onClose,
}: {
  open: boolean;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  confirmLabel: ReactNode;
  confirmIcon?: Icon;
  cancelLabel?: ReactNode;
  danger?: boolean;
  busy?: boolean;
  /** Label of an unticked checkbox that enables the confirm button. */
  check?: ReactNode;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const { t } = useLingui();
  const [checked, setChecked] = useState(false);
  const checkId = useId();
  // Every opening starts unticked.
  useEffect(() => {
    if (open) setChecked(false);
  }, [open]);
  return (
    <Dialog
      open={open}
      onClose={onClose}
      closeLabel={t`Close`}
      title={title}
      description={description}
      footer={
        <>
          <Button variant="secondary" autoFocus={danger} onClick={onClose}>
            {cancelLabel ?? <Trans>Cancel</Trans>}
          </Button>
          <Button
            icon={confirmIcon}
            busy={busy}
            disabled={busy || (check !== undefined && !checked)}
            className={danger ? 'bg-danger hover:bg-danger' : undefined}
            onClick={onConfirm}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      {children}
      {check !== undefined && (
        <label
          htmlFor={checkId}
          className="mt-4 flex min-h-11 cursor-pointer items-start gap-3 rounded-tile bg-danger/8 px-3 py-2.5 text-sm font-semibold"
        >
          <input
            id={checkId}
            type="checkbox"
            checked={checked}
            onChange={(e) => setChecked(e.target.checked)}
            className="mt-0.5 size-5 shrink-0 accent-[var(--omw-danger)]"
          />
          <span>{check}</span>
        </label>
      )}
    </Dialog>
  );
}
