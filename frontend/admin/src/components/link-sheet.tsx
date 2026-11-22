/**
 * A personal link (or the panic link), shown exactly once (spec-wave5 §7.3): the URL to select,
 * [Share] (navigator.share with a short message in German or English, chosen here: the person's
 * language, not the app's) and [Copy]. Closing the sheet drops the link: the caller keeps it in
 * state only while the sheet is open and clears it in onClose.
 */
import { Trans, useLingui } from '@lingui/react/macro';
import { type ReactNode, useEffect, useState } from 'react';
import { CheckIcon, CopyIcon, ShareIcon } from './icons';
import { Button, cx, Dialog, Segmented } from './ui';

export type ShareLocale = 'de' | 'en';

/** The message sent with a personal link, in the person's language (spec §7.3). */
export function personalLinkMessage(name: string, url: string, locale: ShareLocale): string {
  return locale === 'de'
    ? `Hallo ${name}! Hier ist dein persönlicher Link zu meiner Reise. Bitte gib ihn nicht weiter: ${url}`
    : `Hi ${name}! Here is your personal link to my journey. Please do not pass it on: ${url}`;
}

function canShare(): boolean {
  return typeof navigator !== 'undefined' && typeof navigator.share === 'function';
}

export function LinkSheet({
  open,
  title,
  description,
  url,
  shareText,
  note,
  onClose,
}: {
  open: boolean;
  title: ReactNode;
  description?: ReactNode;
  url: string | null;
  /** Message for the share sheet; with a person's name the de/en toggle appears. */
  shareText: ((locale: ShareLocale) => string) | null;
  note: ReactNode;
  onClose: () => void;
}) {
  const { t, i18n } = useLingui();
  const [locale, setLocale] = useState<ShareLocale>(i18n.locale === 'en' ? 'en' : 'de');
  const [copied, setCopied] = useState(false);
  const [shareFailed, setShareFailed] = useState(false);
  useEffect(() => {
    if (!open) {
      setCopied(false);
      setShareFailed(false);
    }
  }, [open]);
  const text = url && shareText ? shareText(locale) : url;

  async function share() {
    if (!url || !text) return;
    try {
      await navigator.share({ text });
    } catch (err) {
      // The owner closed the share sheet: nothing to report. Anything else: offer copying.
      if ((err as Error)?.name !== 'AbortError') setShareFailed(true);
    }
  }

  async function copy() {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <Dialog
      open={open && url !== null}
      onClose={onClose}
      closeLabel={t`Close`}
      title={title}
      description={description}
      footer={
        <Button variant="secondary" onClick={onClose}>
          <Trans>Done</Trans>
        </Button>
      }
    >
      {url && (
        <div className="space-y-4">
          <p
            data-testid="personal-link"
            dir="ltr"
            className="rounded-tile border-2 border-dashed border-accent bg-blush px-3 py-2.5 font-mono text-sm break-all select-all"
          >
            {url}
          </p>
          {shareText && (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-bold">
                <Trans>Message in</Trans>
              </span>
              <Segmented<ShareLocale>
                label={t`Language of the message`}
                size="sm"
                value={locale}
                onChange={setLocale}
                options={[
                  { value: 'de', label: 'Deutsch' },
                  { value: 'en', label: 'English' },
                ]}
              />
            </div>
          )}
          {shareText && text && (
            <p lang={locale} dir="auto" className="rounded-tile bg-bg px-3 py-2 text-sm text-muted">
              {text}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            {canShare() && (
              <Button icon={ShareIcon} onClick={() => void share()}>
                <Trans>Share</Trans>
              </Button>
            )}
            <Button
              variant={canShare() ? 'secondary' : 'primary'}
              icon={copied ? CheckIcon : CopyIcon}
              onClick={() => void copy()}
            >
              {copied ? <Trans>Copied</Trans> : <Trans>Copy link</Trans>}
            </Button>
          </div>
          {shareFailed && (
            <p className="text-sm text-danger">
              <Trans>Sharing did not work. Copy the link instead.</Trans>
            </p>
          )}
          <p className={cx('rounded-tile bg-lilac px-3 py-2.5 text-sm text-ink')}>{note}</p>
        </div>
      )}
    </Dialog>
  );
}
