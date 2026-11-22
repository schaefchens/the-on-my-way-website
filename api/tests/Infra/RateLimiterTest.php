<?php

declare(strict_types=1);

namespace Omw\Api\Tests\Infra;

use Omw\Api\Infra\Clock;
use Omw\Api\Infra\Db;
use Omw\Api\Infra\RateLimiter;
use Omw\Api\Tests\Http\ApiTestCase;

/**
 * Infra\RateLimiter (spec-wave5 §3.7): sliding windows, refusals not recorded, several limits
 * checked and recorded together, hashed subjects (no IP or key in the table), daily salt rotation,
 * pruning after 48 h.
 */
final class RateLimiterTest extends ApiTestCase
{
    public function testSlidingWindowAndRetryAfter(): void
    {
        $this->migrate();
        $limiter = $this->service(RateLimiter::class);
        for ($i = 0; $i < 3; ++$i) {
            self::assertSame(0, $limiter->hit('poll', 'k', 3, 9));
            Clock::advance('+1 second');
        }
        $wait = $limiter->hit('poll', 'k', 3, 9);
        self::assertSame(6, $wait, 'the oldest of the three leaves the window after 9 s');
        self::assertSame(3, $limiter->count('poll', 'k', 9), 'refusals are not recorded');
        self::assertSame(0, $limiter->hit('poll', 'other', 3, 9), 'per subject');
        Clock::advance('+6 seconds');
        self::assertSame(0, $limiter->hit('poll', 'k', 3, 9));
    }

    public function testSeveralLimitsAtOnce(): void
    {
        $this->migrate();
        $limiter = $this->service(RateLimiter::class);
        $limits = [['ip', '192.0.2.1', 2, 600], ['link', 'h', 5, 3600]];
        $answers = [$limiter->hitAll($limits), $limiter->hitAll($limits), $limiter->hitAll($limits)];
        self::assertSame(0, $answers[0]);
        self::assertSame(0, $answers[1]);
        self::assertGreaterThan(0, $answers[2]);
        self::assertSame(2, $limiter->count('link', 'h', 3600), 'nothing recorded when one limit refuses');
    }

    public function testSubjectsAreHashedSaltRotatesAndOldRowsArePruned(): void
    {
        $this->migrate();
        $limiter = $this->service(RateLimiter::class);
        $db = $this->service(Db::class);
        $limiter->hit('ip', '203.0.113.99', 10, 600);
        $bucket = (string) $db->scalar('SELECT bucket FROM rate_events');
        self::assertMatchesRegularExpression('/^ip:[0-9a-f]{32}$/', $bucket);
        self::assertStringNotContainsString('203.0.113.99', json_encode($db->all('SELECT * FROM rate_events'), JSON_THROW_ON_ERROR));

        $salt = $db->scalar("SELECT value FROM meta WHERE key = 'rl_salt'");
        self::assertTrue($limiter->rotateSaltDaily());
        self::assertFalse($limiter->rotateSaltDaily());
        self::assertNotSame($salt, $db->scalar("SELECT value FROM meta WHERE key = 'rl_salt'"));
        self::assertSame(0, $limiter->count('ip', '203.0.113.99', 600), 'a new salt starts every window again (accepted residual)');
        Clock::advance('+1 day');
        self::assertTrue($limiter->rotateSaltDaily());

        Clock::advance('+2 days');
        self::assertSame(1, $limiter->prune());
    }
}
