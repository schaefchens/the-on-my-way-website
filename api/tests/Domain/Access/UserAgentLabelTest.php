<?php

declare(strict_types=1);

namespace Omw\Api\Tests\Domain\Access;

use Omw\Api\Domain\Access\UserAgentLabel;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

/** Device labels from User-Agents (spec-wave5 §3.3 Devices 1); the raw UA is never stored. */
final class UserAgentLabelTest extends TestCase
{
    /** @return iterable<string, array{string|null, string}> */
    public static function agents(): iterable
    {
        yield 'iPhone Safari' => ['Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1', 'iPhone · Safari'];
        yield 'iPhone Chrome' => ['Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/131.0.6778.73 Mobile/15E148 Safari/604.1', 'iPhone · Chrome'];
        yield 'iPhone WhatsApp' => ['Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 WhatsApp/2.24.23', 'iPhone · WhatsApp'];
        yield 'iPhone Instagram' => ['Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 357.0.0.25.101', 'iPhone · Instagram'];
        yield 'iPhone Facebook' => ['Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBAV/490.0]', 'iPhone · Facebook'];
        yield 'iPhone in-app WebKit' => ['Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148', 'iPhone · Safari'];
        yield 'iPad Safari' => ['Mozilla/5.0 (iPad; CPU OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1', 'iPad · Safari'];
        yield 'Android Chrome' => ['Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36', 'Android · Chrome'];
        yield 'Android Samsung' => ['Mozilla/5.0 (Linux; Android 14; SM-S921B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/26.0 Chrome/122.0.0.0 Mobile Safari/537.36', 'Android · Samsung'];
        yield 'Android Firefox' => ['Mozilla/5.0 (Android 15; Mobile; rv:132.0) Gecko/132.0 Firefox/132.0', 'Android · Firefox'];
        yield 'Mac Safari' => ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15', 'Mac · Safari'];
        yield 'Windows Edge' => ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.2903.51', 'Windows · Edge'];
        yield 'Linux Firefox' => ['Mozilla/5.0 (X11; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0', 'Linux · Firefox'];
        yield 'unknown' => ['curl/8.7.1', 'Gerät · Browser'];
        yield 'missing' => [null, 'Gerät · Browser'];
    }

    #[DataProvider('agents')]
    public function testLabels(?string $ua, string $label): void
    {
        self::assertSame($label, UserAgentLabel::of($ua));
        self::assertLessThanOrEqual(60, mb_strlen(UserAgentLabel::of($ua)));
    }
}
