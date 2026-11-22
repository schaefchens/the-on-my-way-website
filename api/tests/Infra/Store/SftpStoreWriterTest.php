<?php

declare(strict_types=1);

namespace Omw\Api\Tests\Infra\Store;

use Omw\Api\AccessConfig;
use Omw\Api\Domain\Access\StoreLayout;
use Omw\Api\Infra\Store\SftpStoreWriter;
use Omw\Api\Infra\Store\StoreWriterException;
use Omw\Api\Tests\TestCase;

/**
 * The SFTP store writer against a fake SftpClient (spec-wave5 §3.8.1, §8.3): the host-key pin,
 * key login preferred, an auth failure as a distinct reason (the applier blocks on it), the refusal
 * of a login that sees the site docroot (unless allowed), exclusive put = stat + put, replace with
 * posix-rename or delete + rename.
 */
final class SftpStoreWriterTest extends TestCase
{
    private FakeSftpClient $client;

    protected function setUp(): void
    {
        parent::setUp();
        $this->client = new FakeSftpClient();
        $this->client->fs = ['/' => null, '/omw-store' => null, '/omw-store/site1' => null];
    }

    /** @param array<string, mixed> $over */
    private function accessConfig(array $over = []): AccessConfig
    {
        $args = array_merge([
            'storeMode' => 'sftp',
            'sftpHost' => 'sftp.example.org',
            'sftpUser' => 'store',
            'sftpPassword' => 'secret password',
            'sftpHostKeys' => [SftpStoreWriter::fingerprint('fake-host-key-blob')],
            'sftpRoot' => '/omw-store/site1',
        ], $over);

        return new AccessConfig(...$args);
    }

    public function testFingerprintFormat(): void
    {
        $fp = SftpStoreWriter::fingerprint('x');
        self::assertMatchesRegularExpression('#^SHA256:[A-Za-z0-9+/]{43}$#', $fp);
        self::assertSame('SHA256:' . rtrim(base64_encode(hash('sha256', 'x', true)), '='), $fp);
    }

    public function testWritesThroughTheClient(): void
    {
        $w = new SftpStoreWriter($this->client, $this->accessConfig());
        $sid = str_repeat('b', 43);
        $path = StoreLayout::session('abcdefgh2345', 'qrst2345', $sid);
        $w->put($path, '', true);
        self::assertSame('connect sftp.example.org:22/5', $this->client->calls[0], '5 s timeout');
        self::assertSame('login-password store', $this->client->calls[1]);
        self::assertArrayHasKey('/omw-store/site1/' . $path, $this->client->fs);
        self::assertContains('chmod /omw-store/site1/s/abcdefgh2345 711', $this->client->calls);
        self::assertContains('chmod /omw-store/site1/' . $path . ' 600', $this->client->calls);

        $this->client->fs['/omw-store/site1/locked'] = 'old';
        $w->put(StoreLayout::LOCKED, 'new', true);
        self::assertSame('old', $this->client->fs['/omw-store/site1/locked'], 'exclusive: stat, then leave it');

        $w->replace(StoreLayout::MARKER, '{"v":1}');
        self::assertSame('{"v":1}', $w->read(StoreLayout::MARKER));
        self::assertNotEmpty(preg_grep('#^posix-rename /omw-store/site1/\.tmp-[0-9a-f]{12} /omw-store/site1/\.omw-store\.json$#', $this->client->calls));
        $this->client->posixRename = false;
        $w->replace(StoreLayout::MARKER, '{"v":2}');
        self::assertSame('{"v":2}', $w->read(StoreLayout::MARKER));
        self::assertNotEmpty(preg_grep('#^rename #', $this->client->calls));

        self::assertSame(1, $w->deletePrefix('s/abcdefgh2345', 'qrst2345.'));
        $w->deleteTree('s/abcdefgh2345');
        self::assertSame([], $w->list('s'));
        $w->close();
        self::assertSame('disconnect', $this->client->calls[array_key_last($this->client->calls)]);
    }

    public function testHostKeyPin(): void
    {
        $this->client->hostKey = 'another key';
        try {
            (new SftpStoreWriter($this->client, $this->accessConfig()))->connect();
            self::fail('accepted an unknown host key');
        } catch (StoreWriterException $e) {
            self::assertSame('host_key', $e->reason);
        }
        self::assertSame(0, $this->client->logins, 'no login attempt on a wrong host key');
    }

    public function testAuthFailureIsItsOwnReasonAndKeysArePreferred(): void
    {
        $this->client->acceptLogin = false;
        try {
            (new SftpStoreWriter($this->client, $this->accessConfig()))->connect();
            self::fail('login refused but connected');
        } catch (StoreWriterException $e) {
            self::assertSame('auth', $e->reason);
            self::assertStringNotContainsString('secret password', $e->getMessage());
        }

        $keyFile = $this->tmpDir() . '/key';
        file_put_contents($keyFile, "-----BEGIN OPENSSH PRIVATE KEY-----\nfake\n-----END OPENSSH PRIVATE KEY-----\n");
        $this->client->acceptLogin = true;
        (new SftpStoreWriter($this->client, $this->accessConfig(['sftpKeyFile' => $keyFile])))->connect();
        self::assertContains('login-key store', $this->client->calls);
    }

    public function testRefusesALoginThatSeesTheSiteDocroot(): void
    {
        $this->client->fs += ['/_' => null, '/index.html' => '<!doctype html>', '/.htaccess' => 'RewriteEngine On'];
        try {
            (new SftpStoreWriter($this->client, $this->accessConfig()))->connect();
            self::fail('accepted the site login');
        } catch (StoreWriterException $e) {
            self::assertSame('site_login', $e->reason);
        }
        (new SftpStoreWriter($this->client, $this->accessConfig(['sftpAllowSiteLogin' => true])))->connect();

        self::assertTrue(SftpStoreWriter::looksLikeSiteRoot(['.htaccess', 'favicon.svg']));
        self::assertTrue(SftpStoreWriter::looksLikeSiteRoot(['.omw-gate.json']));
        self::assertFalse(SftpStoreWriter::looksLikeSiteRoot(['.htaccess', '.omw-store.json', 's', 'h', 't']), 'an F3 store chroot is fine');
        self::assertFalse(SftpStoreWriter::looksLikeSiteRoot([]));
    }

    public function testUnreachableServer(): void
    {
        $this->client->unreachable = true;
        $this->expectException(StoreWriterException::class);
        (new SftpStoreWriter($this->client, $this->accessConfig()))->connect();
    }
}
