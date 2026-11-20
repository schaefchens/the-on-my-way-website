<?php

declare(strict_types=1);

namespace Omw\Api\Tests\Http;

use Omw\Api\Domain\Policy;
use Omw\Api\Infra\Clock;
use Omw\Api\Infra\Db;
use PHPUnit\Framework\Attributes\DataProvider;

/**
 * publish.mode_since across mode and delay changes (review L2-01/L2-03): a switch never turns a
 * public capture back to pending, and never releases what a holding mode keeps back, except
 * review -> delayed (the backlog older than the new delay) and the switch to instant. Checked
 * with the real PATCH endpoint and the PHP policy, for captures at t - 2·d0, t - d0 (exactly the
 * boundary), t - d0/2 and a new one at t + 1 s; plus every prefix of the change feed the patch
 * produced (a backend that has applied only part of it).
 */
final class PublishModeSwitchTest extends ApiTestCase
{
    /** The switch happens here (ApiTestCase::NOW). */
    private const T = self::NOW;

    /** The earlier state is set up three days before the switch. */
    private const SETUP_AT = '2026-11-17T10:00:00.000Z';

    private const D0 = 360; // 6 h

    /**
     * @return iterable<string, array{0: list<array<string, mixed>>, 1: array<string, mixed>, 2: array<string, string>, 3: string}>
     *   setup patches (at SETUP_AT), the switch patch (at T), expected visibility after the
     *   switch per capture, expected mode_since after the switch
     */
    public static function transitions(): iterable
    {
        yield 'instant -> delayed 6h' => [
            [],
            ['publish.mode' => 'delayed', 'publish.delay_minutes' => self::D0],
            ['t-2d0' => 'public', 't-d0' => 'public', 't-d0/2' => 'public', 't+1s' => 'pending'],
            self::T,
        ];
        yield 'instant -> review' => [
            [],
            ['publish.mode' => 'review'],
            ['t-2d0' => 'public', 't-d0' => 'public', 't-d0/2' => 'public', 't+1s' => 'pending'],
            self::T,
        ];
        yield 'delayed 6h -> review' => [
            [['publish.mode' => 'delayed', 'publish.delay_minutes' => self::D0]],
            ['publish.mode' => 'review'],
            ['t-2d0' => 'public', 't-d0' => 'public', 't-d0/2' => 'pending', 't+1s' => 'pending'],
            '2026-11-20T04:00:00.001Z', // t - d0 + 1 ms
        ];
        yield 'review -> delayed 6h (backlog older than the delay is released)' => [
            [['publish.mode' => 'review']],
            ['publish.mode' => 'delayed', 'publish.delay_minutes' => self::D0],
            ['t-2d0' => 'public', 't-d0' => 'public', 't-d0/2' => 'pending', 't+1s' => 'pending'],
            self::SETUP_AT,
        ];
        yield 'delayed: delay 6h -> 12h' => [
            [['publish.mode' => 'delayed', 'publish.delay_minutes' => self::D0]],
            ['publish.delay_minutes' => 2 * self::D0],
            ['t-2d0' => 'public', 't-d0' => 'public', 't-d0/2' => 'pending', 't+1s' => 'pending'],
            '2026-11-20T04:00:00.001Z',
        ];
        yield 'delayed -> instant' => [
            [['publish.mode' => 'delayed', 'publish.delay_minutes' => self::D0]],
            ['publish.mode' => 'instant'],
            ['t-2d0' => 'public', 't-d0' => 'public', 't-d0/2' => 'public', 't+1s' => 'public'],
            self::SETUP_AT,
        ];
        yield 'review -> instant' => [
            [['publish.mode' => 'review']],
            ['publish.mode' => 'instant'],
            ['t-2d0' => 'public', 't-d0' => 'public', 't-d0/2' => 'public', 't+1s' => 'public'],
            self::SETUP_AT,
        ];
    }

    /**
     * @param list<array<string, mixed>> $setup
     * @param array<string, mixed>       $switch
     * @param array<string, string>      $expected
     */
    #[DataProvider('transitions')]
    public function testSwitchNeverFlipsPublicToPendingAndReleasesOnlyWhatItMay(array $setup, array $switch, array $expected, string $since): void
    {
        $this->login();
        Clock::freeze(self::SETUP_AT);
        foreach ($setup as $patch) {
            self::assertSame(200, $this->admin('PATCH', '/api/v1/admin/settings', $patch)->getStatusCode());
        }
        Clock::freeze(self::T);
        $before = $this->policySettings();
        $seq = (int) $this->service(Db::class)->scalar('SELECT MAX(seq) FROM change_log');

        $response = $this->admin('PATCH', '/api/v1/admin/settings', $switch);
        self::assertSame(200, $response->getStatusCode(), (string) $response->getBody());
        $after = $this->policySettings();
        self::assertSame($since, $after['publish.mode_since']);

        $captures = self::captures();
        $old = self::visibilities($before, $captures);
        $new = self::visibilities($after, $captures);
        self::assertSame($expected, $new);
        self::assertNoForbiddenFlips($before, $after, $old, $new, $captures, 'after the switch');

        // Every prefix of the feed items this patch produced is harmless on its own.
        $items = self::json($this->backend('GET', '/api/v1/backend/changes?after=' . $seq))['items'];
        $partial = $before;
        foreach ($items as $i => $item) {
            self::assertSame('setting', $item['entity']);
            $partial[$item['key']] = $item['data']['value'];
            $mid = self::visibilities($partial, $captures);
            foreach (['t-2d0', 't-d0', 't-d0/2'] as $label) {
                self::assertFalse($old[$label] === 'public' && $mid[$label] === 'pending', "feed prefix #$i ({$item['key']}): $label public -> pending");
            }
        }
    }

    public function testShorterDelayReleasesWhatIsOlderThanTheNewDelay(): void
    {
        $this->login();
        Clock::freeze(self::SETUP_AT);
        $this->admin('PATCH', '/api/v1/admin/settings', ['publish.mode' => 'delayed', 'publish.delay_minutes' => 2 * self::D0]);
        Clock::freeze(self::T);
        $before = $this->policySettings();
        $this->admin('PATCH', '/api/v1/admin/settings', ['publish.delay_minutes' => self::D0]);
        $after = $this->policySettings();
        self::assertSame('2026-11-19T22:00:00.001Z', $after['publish.mode_since'], 't - 12h + 1 ms');

        $captures = ['t-9h' => '2026-11-20T01:00:00.000Z', 't-3h' => '2026-11-20T07:00:00.000Z', 't-13h' => '2026-11-19T21:00:00.000Z'];
        self::assertSame(['t-9h' => 'pending', 't-3h' => 'pending', 't-13h' => 'public'], self::visibilities($before, $captures));
        self::assertSame(['t-9h' => 'public', 't-3h' => 'pending', 't-13h' => 'public'], self::visibilities($after, $captures));
    }

    public function testDelayedReviewDelayedRoundTripKeepsTheCutOff(): void
    {
        $this->login();
        Clock::freeze(self::SETUP_AT);
        $this->admin('PATCH', '/api/v1/admin/settings', ['publish.mode' => 'delayed', 'publish.delay_minutes' => self::D0]);
        Clock::freeze('2026-11-19T10:00:00.000Z');
        $this->admin('PATCH', '/api/v1/admin/settings', ['publish.mode' => 'review']);
        self::assertSame('2026-11-19T04:00:00.001Z', $this->policySettings()['publish.mode_since']);
        Clock::freeze(self::T);
        $this->admin('PATCH', '/api/v1/admin/settings', ['publish.mode' => 'delayed']);
        self::assertSame('2026-11-19T04:00:00.001Z', $this->policySettings()['publish.mode_since'], 'review -> delayed keeps it');

        // Unrelated patches (and review-mode delay changes) never move it.
        $this->admin('PATCH', '/api/v1/admin/settings', ['site.title' => 'Elsewhere']);
        $this->admin('PATCH', '/api/v1/admin/settings', ['publish.mode' => 'review']);
        $since = $this->policySettings()['publish.mode_since'];
        Clock::advance('+1 hour');
        $this->admin('PATCH', '/api/v1/admin/settings', ['publish.delay_minutes' => 60]);
        self::assertSame($since, $this->policySettings()['publish.mode_since']);
    }

    public function testFeedOrderIsModeSinceThenDelayThenMode(): void
    {
        $this->login();
        $db = $this->service(Db::class);
        $seq = (int) $db->scalar('SELECT MAX(seq) FROM change_log');
        $this->admin('PATCH', '/api/v1/admin/settings', [
            'site.title' => 'Trip', 'publish.mode' => 'delayed', 'publish.delay_minutes' => 90, 'alerts.email' => 'me@example.org',
        ]);
        $keys = array_column(self::json($this->backend('GET', '/api/v1/backend/changes?after=' . $seq))['items'], 'key');
        self::assertSame(['publish.mode_since', 'publish.delay_minutes', 'publish.mode', 'site.title', 'alerts.email'], $keys);
        self::assertSame(['publish.mode_since', 'publish.delay_minutes', 'publish.mode'], array_slice(\Omw\Api\Domain\Settings::WRITE_ORDER, 0, 3));
        self::assertEqualsCanonicalizing(\Omw\Api\Domain\Settings::KEYS, \Omw\Api\Domain\Settings::WRITE_ORDER, 'every key is written');
    }

    public function testNextModeSinceIsPure(): void
    {
        $epoch = Policy::MODE_SINCE_EPOCH;
        $s = static fn (string $mode, int $delay, string $since = Policy::MODE_SINCE_EPOCH): array => ['publish.mode' => $mode, 'publish.delay_minutes' => $delay, 'publish.mode_since' => $since];
        $t = '2026-11-20T10:00:00.000Z';

        self::assertSame($t, Policy::nextModeSince($s('instant', 60), $s('delayed', 60), $t));
        self::assertSame($epoch, Policy::nextModeSince($s('instant', 60), $s('instant', 120), $t));
        self::assertSame('2026-11-20T09:00:00.001Z', Policy::nextModeSince($s('delayed', 60), $s('review', 60), $t));
        self::assertSame('2026-11-20T09:30:00.000Z', Policy::nextModeSince($s('delayed', 60, '2026-11-20T09:30:00.000Z'), $s('review', 60), $t), 'max(s0, …)');
        self::assertSame('2026-11-20T10:00:00.001Z', Policy::nextModeSince($s('delayed', 0), $s('review', 0), $t), 'delay 0: everything so far was public');
        self::assertSame($epoch, Policy::nextModeSince($s('review', 60), $s('delayed', 30), $t));
        self::assertSame($epoch, Policy::nextModeSince($s('delayed', 60), $s('delayed', 60), $t));
        self::assertSame($epoch, Policy::nextModeSince($s('delayed', 60), $s('instant', 60), $t));
    }

    /** @return array<string, mixed> */
    private function policySettings(): array
    {
        $all = self::json($this->admin('GET', '/api/v1/admin/settings'));

        return [
            'publish.mode' => $all['publish.mode'],
            'publish.delay_minutes' => $all['publish.delay_minutes'],
            'ingest.on_revoke' => $all['ingest.on_revoke'],
            'publish.mode_since' => $all['publish.mode_since'],
        ];
    }

    /** @return array<string, string> label => occurredAt */
    private static function captures(): array
    {
        return [
            't-2d0' => '2026-11-19T22:00:00.000Z',
            't-d0' => '2026-11-20T04:00:00.000Z',
            't-d0/2' => '2026-11-20T07:00:00.000Z',
            't+1s' => '2026-11-20T10:00:01.000Z',
        ];
    }

    /**
     * Visibility of each capture under $settings. Captures that exist at the switch are judged at
     * T; the new one at its own time (+1 s), i.e. right after it arrived.
     *
     * @param array<string, mixed>  $settings
     * @param array<string, string> $captures
     * @return array<string, string>
     */
    private static function visibilities(array $settings, array $captures): array
    {
        $out = [];
        foreach ($captures as $label => $occurredAt) {
            $now = $occurredAt > self::T ? $occurredAt : self::T;
            $out[$label] = Policy::effectiveCaptureVisibility($occurredAt, null, null, $settings, $now);
        }

        return $out;
    }

    /**
     * @param array<string, mixed>  $before
     * @param array<string, mixed>  $after
     * @param array<string, string> $old
     * @param array<string, string> $new
     * @param array<string, string> $captures
     */
    private static function assertNoForbiddenFlips(array $before, array $after, array $old, array $new, array $captures, string $when): void
    {
        $delayMs = (int) $after['publish.delay_minutes'] * 60_000;
        foreach ($captures as $label => $occurredAt) {
            if ($occurredAt > self::T) {
                continue; // arrives after the switch: the new mode simply applies
            }
            self::assertFalse($old[$label] === 'public' && $new[$label] === 'pending', "$when: $label public -> pending");
            if ($old[$label] === 'pending' && $new[$label] === 'public') {
                $toInstant = $after['publish.mode'] === 'instant';
                $reviewToDelayed = $before['publish.mode'] === 'review' && $after['publish.mode'] === 'delayed'
                    && \Omw\Api\Domain\Time::millis(self::T) - \Omw\Api\Domain\Time::millis($occurredAt) >= $delayMs;
                self::assertTrue($toInstant || $reviewToDelayed, "$when: $label pending -> public is not allowed for this switch");
            }
        }
    }
}
