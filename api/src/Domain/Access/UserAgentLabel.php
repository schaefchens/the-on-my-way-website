<?php

declare(strict_types=1);

namespace Omw\Api\Domain\Access;

/**
 * A short device label from a User-Agent ("iPhone · Safari"); the raw UA is never stored
 * (spec-wave5 §3.3 Devices 1). Platform ∈ {iPhone, iPad, Android, Mac, Windows, Linux, Gerät},
 * browser ∈ {Safari, Chrome, Firefox, Edge, Samsung, WhatsApp, Instagram, Facebook, Browser}.
 */
final class UserAgentLabel
{
    public static function of(?string $userAgent): string
    {
        $ua = $userAgent ?? '';

        return self::platform($ua) . ' · ' . self::browser($ua);
    }

    private static function platform(string $ua): string
    {
        return match (true) {
            str_contains($ua, 'iPhone') || str_contains($ua, 'iPod') => 'iPhone',
            str_contains($ua, 'iPad') => 'iPad',
            str_contains($ua, 'Android') => 'Android',
            str_contains($ua, 'Windows') => 'Windows',
            str_contains($ua, 'Macintosh') || str_contains($ua, 'Mac OS X') => 'Mac',
            str_contains($ua, 'Linux') || str_contains($ua, 'X11') || str_contains($ua, 'CrOS') => 'Linux',
            default => 'Gerät',
        };
    }

    private static function browser(string $ua): string
    {
        return match (true) {
            str_contains($ua, 'WhatsApp') => 'WhatsApp',
            str_contains($ua, 'Instagram') => 'Instagram',
            preg_match('#FBAN|FBAV|FB_IAB|FBIOS|FB4A#', $ua) === 1 => 'Facebook',
            str_contains($ua, 'SamsungBrowser') => 'Samsung',
            preg_match('#Edg(?:e|A|iOS)?/#', $ua) === 1 => 'Edge',
            str_contains($ua, 'Firefox/') || str_contains($ua, 'FxiOS/') => 'Firefox',
            str_contains($ua, 'Chrome/') || str_contains($ua, 'CriOS/') || str_contains($ua, 'Chromium/') => 'Chrome',
            str_contains($ua, 'Safari/') || (str_contains($ua, 'AppleWebKit/') && (str_contains($ua, 'iPhone') || str_contains($ua, 'iPad'))) => 'Safari',
            default => 'Browser',
        };
    }
}
