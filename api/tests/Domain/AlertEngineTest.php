<?php

declare(strict_types=1);

namespace Omw\Api\Tests\Domain;

use DateTimeImmutable;
use Omw\Api\Domain\Alerts\AlertEngine;
use Omw\Api\Domain\Alerts\Notification;
use Omw\Api\Domain\Alerts\Notifier;
use Omw\Api\Domain\BackendStatus;
use Omw\Api\Domain\ChangeLog;
use Omw\Api\Domain\Settings;
use Omw\Api\Infra\Clock;
use Omw\Api\Infra\Db;
use Omw\Api\Infra\SchemaValidator;
use Omw\Api\Tests\Http\BackendApiTest;
use Omw\Api\Tests\TestCase;
use RuntimeException;

/**
 * The alert state machine with a fake clock and a fake notifier: open -> repeat -> resolve ->
 * resolved notice; delivery failures are retried; no channel = recorded but silent.
 */
final class AlertEngineTest extends TestCase
{
    private Db $db;
    private BackendStatus $status;
    private Settings $settings;
    private FakeNotifier $notifier;
    private AlertEngine $engine;

    protected function setUp(): void
    {
        parent::setUp();
        Clock::freeze('2026-11-20T10:00:00.000Z');
        $config = $this->config(['ALERT_REPEAT_MINUTES' => '60', 'PUBLISH_FAIL_THRESHOLD' => '3']);
        $this->db = $this->migratedDb($config);
        $schemas = SchemaValidator::fromRoot(self::rootDir());
        $this->status = new BackendStatus($this->db);
        $this->settings = new Settings($this->db, new ChangeLog($this->db, $schemas), $schemas);
        $this->notifier = new FakeNotifier();
        $this->engine = new AlertEngine($this->db, $this->status, $this->settings, $this->notifier, $config);
    }

    protected function tearDown(): void
    {
        Clock::unfreeze();
        parent::tearDown();
    }

    private function heartbeat(string $state = 'open'): void
    {
        $this->status->recordHeartbeat(SchemaValidator::toJsonValue(BackendApiTest::heartbeat($state)));
    }

    /** @return array{opened: list<string>, repeated: list<string>, resolved: list<string>, failed: list<string>} */
    private function runAt(string $at): array
    {
        Clock::freeze($at);

        return $this->engine->run(new DateTimeImmutable($at));
    }

    public function testNothingFiresWithoutABackendYet(): void
    {
        self::assertSame(['opened' => [], 'repeated' => [], 'resolved' => [], 'failed' => []], $this->runAt('2026-11-20T12:00:00.000Z'));
        self::assertSame([], $this->notifier->sent);
    }

    public function testHeartbeatStaleLifecycle(): void
    {
        $this->heartbeat();
        self::assertSame([], $this->runAt('2026-11-20T10:14:00.000Z')['opened'], '14 min: not stale yet');

        $opened = $this->runAt('2026-11-20T10:15:00.000Z');
        self::assertSame(['heartbeat_stale'], $opened['opened']);
        self::assertCount(1, $this->notifier->sent);
        self::assertStringContainsString('ALERT', $this->notifier->sent[0]->title);
        self::assertSame('critical', $this->notifier->sent[0]->severity);

        // Not repeated before ALERT_REPEAT_MINUTES; repeated after; still one open row.
        self::assertSame([], $this->runAt('2026-11-20T11:00:00.000Z')['repeated']);
        self::assertSame(['heartbeat_stale'], $this->runAt('2026-11-20T11:15:00.000Z')['repeated']);
        self::assertCount(2, $this->notifier->sent);
        self::assertSame(1, (int) $this->db->scalar("SELECT COUNT(*) FROM alerts WHERE state = 'open'"));
        self::assertStringContainsString('75 minutes', (string) $this->db->scalar('SELECT message FROM alerts'), 'message refreshed');

        // The backend comes back -> resolved + one resolved notice.
        Clock::freeze('2026-11-20T11:20:00.000Z');
        $this->heartbeat();
        $resolved = $this->runAt('2026-11-20T11:20:00.000Z');
        self::assertSame(['heartbeat_stale'], $resolved['resolved']);
        self::assertCount(3, $this->notifier->sent);
        self::assertTrue($this->notifier->sent[2]->resolved);
        self::assertStringContainsString('Resolved', $this->notifier->sent[2]->title);
        $this->runAt('2026-11-20T11:25:00.000Z');
        self::assertCount(3, $this->notifier->sent, 'resolved notice only once');

        // The status view shows the resolved alert for a day.
        $alerts = $this->status->status()['alerts'];
        self::assertCount(1, $alerts);
        self::assertSame('2026-11-20T11:20:00.000Z', $alerts[0]['resolvedAt']);
        self::assertSame('2026-11-20T10:15:00.000Z', $alerts[0]['since']);
    }

    public function testWhatsAppStatesAndPublishFailures(): void
    {
        $this->heartbeat('logged_out');
        self::assertSame(['wa_logged_out'], $this->runAt('2026-11-20T10:00:00.000Z')['opened']);

        // publish_failing opens only at PUBLISH_FAIL_THRESHOLD consecutive failures.
        $report = ['contractVersion' => 1, 'version' => 1, 'target' => 'sftp-main', 'ok' => false, 'uploaded' => 0, 'deleted' => 0,
            'feedSeq' => 0, 'capturesThrough' => null, 'error' => 'auth failed'];
        $opened = [];
        foreach (['10:01', '10:02', '10:03'] as $time) {
            $this->status->recordPublished((object) (['at' => "2026-11-20T{$time}:00Z"] + $report));
            $opened[] = $this->runAt("2026-11-20T{$time}:30.000Z")['opened'];
        }
        self::assertSame([[], [], ['publish_failing']], $opened);
        self::assertStringContainsString('sftp-main failed 3 times in a row (auth failed)', (string) $this->db->scalar("SELECT message FROM alerts WHERE kind = 'publish_failing'"));
        self::assertSame('warning', $this->db->scalar("SELECT severity FROM alerts WHERE kind = 'publish_failing'"));

        // Banned replaces logged_out; a successful deploy resolves publish_failing.
        $this->heartbeat('banned');
        $this->status->recordPublished((object) (['at' => '2026-11-20T10:04:00Z', 'ok' => true] + $report));
        $result = $this->runAt('2026-11-20T10:05:00.000Z');
        self::assertSame(['wa_banned'], $result['opened']);
        self::assertSame(['wa_logged_out', 'publish_failing'], $result['resolved']);
        self::assertSame(['wa_banned'], array_column($this->db->all("SELECT kind FROM alerts WHERE state = 'open'"), 'kind'));
    }

    public function testFailedDeliveriesAreRetriedAndNoChannelIsSilent(): void
    {
        $this->heartbeat();
        $this->notifier->fail = true;
        $first = $this->runAt('2026-11-20T10:30:00.000Z');
        self::assertSame(['heartbeat_stale'], $first['opened']);
        self::assertSame(['heartbeat_stale'], $first['failed']);
        self::assertNull($this->db->scalar('SELECT last_notified_at FROM alerts'));

        // Next run retries immediately (not after the repeat interval).
        $this->notifier->fail = false;
        self::assertSame(['heartbeat_stale'], $this->runAt('2026-11-20T10:35:00.000Z')['repeated']);
        self::assertSame(1, (int) $this->db->scalar('SELECT notify_count FROM alerts'));

        // Resolved notice fails once, then goes out on the next run.
        Clock::freeze('2026-11-20T10:40:00.000Z');
        $this->heartbeat();
        $this->notifier->fail = true;
        $resolved = $this->runAt('2026-11-20T10:40:00.000Z');
        self::assertSame(['heartbeat_stale'], $resolved['resolved']);
        self::assertSame(['heartbeat_stale'], $resolved['failed']);
        $this->notifier->fail = false;
        $this->runAt('2026-11-20T10:45:00.000Z');
        self::assertTrue(end($this->notifier->sent) instanceof Notification && end($this->notifier->sent)->resolved);
        self::assertNotNull($this->db->scalar('SELECT resolved_notified_at FROM alerts'));

        // No channel configured: the alert is recorded, nothing is "delivered", no resolved notice later.
        $this->notifier->channels = 0;
        $before = count($this->notifier->sent);
        $this->runAt('2026-11-20T11:30:00.000Z');
        self::assertSame(1, (int) $this->db->scalar("SELECT COUNT(*) FROM alerts WHERE state = 'open'"));
        self::assertSame(0, (int) $this->db->scalar("SELECT notify_count FROM alerts WHERE state = 'open'"));
        Clock::freeze('2026-11-20T11:31:00.000Z');
        $this->heartbeat();
        $this->runAt('2026-11-20T11:31:00.000Z');
        self::assertCount($before + 1, $this->notifier->sent, 'only the (undelivered) opening attempt');
    }

    public function testATargetTheBackendStopsReportingNoLongerFails(): void
    {
        $report = static fn (string $target, bool $ok, string $at): object => (object) [
            'contractVersion' => 1, 'version' => 1, 'at' => $at, 'target' => $target, 'ok' => $ok, 'uploaded' => 0, 'deleted' => 0,
            'feedSeq' => 0, 'capturesThrough' => null, 'error' => $ok ? null : 'connection refused',
        ];
        $publish = function (string $target, bool $ok, string $at) use ($report): void {
            Clock::freeze($at);
            $this->status->recordPublished($report($target, $ok, $at));
        };

        // B fails three times in a row while A works.
        foreach (['10:01', '10:02', '10:03'] as $time) {
            $publish('a-main', true, "2026-11-20T{$time}:00.000Z");
            $publish('b-old', false, "2026-11-20T{$time}:10.000Z");
        }
        self::assertSame(['publish_failing'], $this->runAt('2026-11-20T10:05:00.000Z')['opened']);

        // B was removed from the backend: only A keeps reporting, daily.
        for ($day = 21; $day <= 27; ++$day) {
            $publish('a-main', true, "2026-11-{$day}T10:00:00.000Z");
            self::assertSame([], $this->runAt("2026-11-{$day}T10:05:00.000Z")['resolved'], "day $day: not stale yet");
            self::assertSame(['a-main', 'b-old'], array_column($this->status->publishStatus(), 'target'));
        }
        // Seven days and a bit after B's last report, B is stale: resolved, with a note.
        $publish('a-main', true, '2026-11-27T10:03:11.000Z');
        self::assertSame(['b-old'], $this->status->staleTargets());
        $resolved = $this->runAt('2026-11-27T10:05:00.000Z');
        self::assertSame(['publish_failing'], $resolved['resolved']);
        $message = (string) $this->db->scalar("SELECT message FROM alerts WHERE kind = 'publish_failing'");
        self::assertStringEndsWith('Target no longer reported: b-old.', $message);
        self::assertTrue(end($this->notifier->sent) instanceof Notification && end($this->notifier->sent)->resolved);
        self::assertStringContainsString('no longer reported: b-old', end($this->notifier->sent)->message);
        self::assertSame(['a-main'], array_column($this->status->status()['publish'], 'target'));
        self::assertSame([], $this->runAt('2026-11-27T10:10:00.000Z')['opened'], 'B does not re-open it');

        // The row goes 30 days after B's last report (cron cleanup), not before.
        self::assertSame(0, $this->status->pruneStaleTargets(new DateTimeImmutable('2026-12-20T10:03:00.000Z')));
        self::assertSame(1, $this->status->pruneStaleTargets(new DateTimeImmutable('2026-12-20T10:03:11.000Z')));
        self::assertSame(['a-main'], $this->status->knownTargets());

        // A single target that stops reporting is never "stale" (heartbeat_stale covers that).
        Clock::freeze('2027-02-01T00:00:00.000Z');
        self::assertSame([], $this->status->staleTargets());
    }

    public function testAFailingTargetNextToAStaleOneKeepsTheAlertOpen(): void
    {
        $base = ['contractVersion' => 1, 'version' => 1, 'ok' => false, 'uploaded' => 0, 'deleted' => 0, 'feedSeq' => 0, 'capturesThrough' => null];
        foreach (['10:01', '10:02', '10:03'] as $time) {
            foreach (['a-main', 'b-old'] as $target) {
                Clock::freeze("2026-11-20T{$time}:00.000Z");
                $this->status->recordPublished((object) (['at' => "2026-11-20T{$time}:00.000Z", 'target' => $target] + $base));
            }
        }
        self::assertSame(['publish_failing'], $this->runAt('2026-11-20T10:05:00.000Z')['opened']);
        Clock::freeze('2026-11-28T10:00:00.000Z');
        $this->status->recordPublished((object) (['at' => '2026-11-28T10:00:00.000Z', 'target' => 'a-main'] + $base));
        self::assertSame([], $this->runAt('2026-11-28T10:05:00.000Z')['resolved']);
        $message = (string) $this->db->scalar("SELECT message FROM alerts WHERE kind = 'publish_failing'");
        self::assertStringContainsString('a-main failed 4 times', $message);
        self::assertStringNotContainsString('b-old', $message);
    }

    public function testStaleThresholdComesFromTheSettings(): void
    {
        $this->settings->patch((object) ['alerts.heartbeat_stale_minutes' => 60]);
        $this->heartbeat();
        self::assertSame([], $this->runAt('2026-11-20T10:59:00.000Z')['opened']);
        self::assertSame(['heartbeat_stale'], $this->runAt('2026-11-20T11:00:00.000Z')['opened']);
    }
}

/** Records notifications; can simulate failing channels or no channel at all. */
final class FakeNotifier implements Notifier
{
    /** @var list<Notification> */
    public array $sent = [];
    public bool $fail = false;
    public int $channels = 1;

    public function send(Notification $notification): int
    {
        if ($this->fail) {
            throw new RuntimeException('smtp down');
        }
        $this->sent[] = $notification;

        return $this->channels;
    }
}
