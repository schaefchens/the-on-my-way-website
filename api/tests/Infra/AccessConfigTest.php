<?php

declare(strict_types=1);

namespace Omw\Api\Tests\Infra;

use InvalidArgumentException;
use Omw\Api\Tests\TestCase;

/** ACCESS_* configuration (spec-wave5 §3.1): defaults and every refusal. */
final class AccessConfigTest extends TestCase
{
    public function testDefaults(): void
    {
        $a = $this->config()->access;
        self::assertSame('none', $a->storeMode);
        self::assertSame('headers', $a->cookieMode);
        self::assertSame(0o711, $a->dirMode);
        self::assertSame(0o600, $a->fileMode);
        self::assertSame(5, $a->maxDevices);
        self::assertFalse($a->gateProbe);
        self::assertFalse($a->sftpAllowSiteLogin);
        self::assertFalse($a->apiWrites());
    }

    public function testValidSetups(): void
    {
        $direct = $this->config(['SITE_ORIGIN' => 'https://site.example', 'ACCESS_STORE_MODE' => 'direct', 'ACCESS_STORE_DIR' => '/usr/home/omw/omw-store/site1', 'ACCESS_STORE_DIR_MODE' => '0755', 'ACCESS_STORE_FILE_MODE' => '644'])->access;
        self::assertTrue($direct->apiWrites());
        self::assertSame(0o755, $direct->dirMode);
        self::assertSame(0o644, $direct->fileMode);

        $pin = 'SHA256:' . str_repeat('A', 43);
        $sftp = $this->config([
            'SITE_ORIGIN' => 'https://site.example', 'ACCESS_STORE_MODE' => 'sftp', 'ACCESS_STORE_SFTP_HOST' => 'sftp.example.org',
            'ACCESS_STORE_SFTP_USER' => 'store', 'ACCESS_STORE_SFTP_KEY_FILE' => 'var/keys/store', 'ACCESS_STORE_SFTP_HOSTKEYS' => "$pin, SHA256:" . str_repeat('b', 43),
            'ACCESS_STORE_SFTP_ROOT' => 'omw-store/site1', 'ACCESS_STORE_SFTP_PORT' => '2222',
        ])->access;
        self::assertSame(2222, $sftp->sftpPort);
        self::assertCount(2, $sftp->sftpHostKeys);
        self::assertSame(self::rootDir() . '/var/keys/store', $sftp->sftpKeyFile);

        $parent = $this->config(['SITE_ORIGIN' => 'https://www.example.org', 'APP_URL' => 'https://api.example.org', 'ACCESS_COOKIE_MODE' => 'parent', 'ACCESS_COOKIE_DOMAIN' => 'Example.org'])->access;
        self::assertTrue($parent->isParent());
        self::assertSame('example.org', $parent->cookieDomain);
        self::assertSame(20, $this->config(['ACCESS_MAX_DEVICES' => '20', 'ACCESS_GATE_PROBE' => 'true'])->access->maxDevices);
    }

    /** @return iterable<string, array{array<string, string>}> */
    public static function invalid(): iterable
    {
        $pin = 'SHA256:' . str_repeat('A', 43);
        $sftp = ['SITE_ORIGIN' => 'https://site.example', 'ACCESS_STORE_MODE' => 'sftp', 'ACCESS_STORE_SFTP_HOST' => 'sftp.example.org', 'ACCESS_STORE_SFTP_USER' => 'u', 'ACCESS_STORE_SFTP_PASSWORD' => 'p', 'ACCESS_STORE_SFTP_HOSTKEYS' => $pin, 'ACCESS_STORE_SFTP_ROOT' => '/s'];
        yield 'unknown mode' => [['ACCESS_STORE_MODE' => 'ftp']];
        yield 'writer without SITE_ORIGIN' => [['ACCESS_STORE_MODE' => 'direct', 'ACCESS_STORE_DIR' => '/a']];
        yield 'direct without dir' => [['SITE_ORIGIN' => 'https://s.example', 'ACCESS_STORE_MODE' => 'direct']];
        yield 'relative dir' => [['ACCESS_STORE_DIR' => 'store']];
        yield 'dir with ..' => [['ACCESS_STORE_DIR' => '/a/../b']];
        yield 'dir with //' => [['ACCESS_STORE_DIR' => '/a//b']];
        yield 'dir with space' => [['ACCESS_STORE_DIR' => '/a b']];
        yield 'dir with $' => [['ACCESS_STORE_DIR' => '/a$b']];
        yield 'dir trailing slash' => [['ACCESS_STORE_DIR' => '/a/']];
        yield 'sftp without host key' => [array_merge($sftp, ['ACCESS_STORE_SFTP_HOSTKEYS' => ''])];
        yield 'bad host key' => [array_merge($sftp, ['ACCESS_STORE_SFTP_HOSTKEYS' => 'MD5:abc'])];
        yield 'sftp without credentials' => [array_merge($sftp, ['ACCESS_STORE_SFTP_PASSWORD' => ''])];
        yield 'sftp without root' => [array_merge($sftp, ['ACCESS_STORE_SFTP_ROOT' => ''])];
        yield 'sftp root with ..' => [array_merge($sftp, ['ACCESS_STORE_SFTP_ROOT' => '/a/../b'])];
        yield 'bad port' => [array_merge($sftp, ['ACCESS_STORE_SFTP_PORT' => '70000'])];
        yield 'bad octal' => [['ACCESS_STORE_DIR_MODE' => '0799']];
        yield 'bad cookie mode' => [['ACCESS_COOKIE_MODE' => 'cookie']];
        yield 'parent without domain' => [['SITE_ORIGIN' => 'https://www.example.org', 'ACCESS_COOKIE_MODE' => 'parent']];
        yield 'parent one label' => [['SITE_ORIGIN' => 'https://www.example.org', 'ACCESS_COOKIE_MODE' => 'parent', 'ACCESS_COOKIE_DOMAIN' => 'org']];
        yield 'parent not a suffix of the site' => [['SITE_ORIGIN' => 'https://www.example.org', 'ACCESS_COOKIE_MODE' => 'parent', 'ACCESS_COOKIE_DOMAIN' => 'other.org']];
        yield 'parent not a suffix of the API' => [['SITE_ORIGIN' => 'https://www.example.org', 'APP_URL' => 'https://api.other.org', 'ACCESS_COOKIE_MODE' => 'parent', 'ACCESS_COOKIE_DOMAIN' => 'example.org']];
        yield 'parent on an IP' => [['SITE_ORIGIN' => 'https://10.0.0.1', 'ACCESS_COOKIE_MODE' => 'parent', 'ACCESS_COOKIE_DOMAIN' => '0.0.1']];
        yield 'device cap 0' => [['ACCESS_MAX_DEVICES' => '0']];
        yield 'device cap 21' => [['ACCESS_MAX_DEVICES' => '21']];
    }

    /** @param array<string, string> $env */
    #[\PHPUnit\Framework\Attributes\DataProvider('invalid')]
    public function testRefusals(array $env): void
    {
        $this->expectException(InvalidArgumentException::class);
        $this->config($env);
    }
}
