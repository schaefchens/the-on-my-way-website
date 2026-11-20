<?php

declare(strict_types=1);

namespace Omw\Api\Tests\Infra;

use Omw\Api\Infra\HttpClient;
use Omw\Api\Infra\OutboundUrl;
use Omw\Api\Infra\PublicAddressGuard;
use Omw\Api\Tests\TestCase;
use PHPUnit\Framework\Attributes\DataProvider;
use RuntimeException;

/**
 * Outgoing requests to admin-chosen URLs (review L1-02): URL normalization, the address rules,
 * and that a pinned request really connects to the vetted address whatever the host name
 * resolves to (a ".invalid" name, which never resolves, reaches a local server only through the
 * pin), with curl and with the PHP stream fallback.
 */
final class HttpClientTest extends TestCase
{
    /** @return iterable<string, array{0: string, 1: string|null}> */
    public static function addresses(): iterable
    {
        foreach (['8.8.8.8', '93.184.216.34', '203.0.113.7', '2606:4700:4700::1111', '2a01:4f8::1', '::ffff:8.8.8.8', '2002:0808:0808::1'] as $ip) {
            yield "public $ip" => [$ip, null];
        }
        $blocked = [
            '0.0.0.0' => 'unspecified', '0.1.2.3' => 'unspecified', '10.0.0.1' => 'private', '10.255.255.255' => 'private',
            '100.64.0.1' => 'carrier-grade NAT', '100.127.255.254' => 'carrier-grade NAT', '127.0.0.1' => 'loopback',
            '127.255.0.9' => 'loopback', '169.254.169.254' => 'link-local', '172.16.0.1' => 'private', '172.31.255.255' => 'private',
            '192.168.0.1' => 'private', '192.0.0.8' => 'IETF', '198.18.0.1' => 'benchmarking', '224.0.0.1' => 'multicast',
            '255.255.255.255' => 'reserved', '::' => 'unspecified', '::1' => 'loopback', 'fc00::1' => 'unique-local',
            'fdff:ffff::1' => 'unique-local', 'fe80::1' => 'link-local', 'febf::1' => 'link-local', 'fec0::1' => 'site-local',
            'ff02::1' => 'multicast', '100::1' => 'discard-only', '::ffff:127.0.0.1' => 'loopback (embedded',
            '::ffff:10.0.0.1' => 'private (RFC 1918) (embedded', '64:ff9b::a9fe:a9fe' => 'link-local (embedded',
            '2002:c0a8:0101::1' => 'private (RFC 1918) (embedded', '::127.0.0.1' => 'loopback (embedded', 'nonsense' => 'unparsable',
        ];
        foreach ($blocked as $ip => $label) {
            yield "blocked $ip" => [$ip, $label];
        }
        yield 'public 100.63.255.255 (just below CGNAT)' => ['100.63.255.255', null];
        yield 'public 172.32.0.1 (just above RFC 1918)' => ['172.32.0.1', null];
    }

    #[DataProvider('addresses')]
    public function testAddressRules(string $ip, ?string $label): void
    {
        $reason = PublicAddressGuard::blockedReason($ip);
        if ($label === null) {
            self::assertNull($reason);
        } else {
            self::assertIsString($reason);
            self::assertStringContainsString($label, $reason);
        }
    }

    public function testOutboundUrlNormalization(): void
    {
        $url = OutboundUrl::parse('HTTPS://Ntfy.SH.:443/topic?x=1#frag');
        self::assertSame('https://ntfy.sh', $url->origin());
        self::assertSame('https://ntfy.sh/topic?x=1', $url->toString());
        self::assertSame('http://[2001:db8::1]:8080/', OutboundUrl::parse('http://[2001:DB8::1]:8080')->toString());
        self::assertTrue(OutboundUrl::parse('http://[2001:db8::1]/')->isIpLiteral());
        self::assertSame('https://ntfy.example.org:8443', OutboundUrl::originOf('https://ntfy.example.org:8443/x'));
        self::assertNull(OutboundUrl::originOf('ftp://ntfy.sh'));

        foreach ([
            'https://user@ntfy.sh/t', 'https://ntfy.sh\\@evil.example/t', "https://ntfy.sh/t\n", 'https://ntfy.sh /t', 'https://exa_mple.org/t',
            'https://127.1/t', 'https://0x7f000001/t', 'https://010.1.1.1/t', 'https://[::1/t', 'file:///etc/passwd', 'https:///t', 'https://ntfy.sh:0/t',
        ] as $bad) {
            try {
                OutboundUrl::parse($bad);
                self::fail('accepted ' . json_encode($bad));
            } catch (\InvalidArgumentException) {
                self::addToAssertionCount(1);
            }
        }
    }

    public function testGuardChecksEveryAddress(): void
    {
        $guard = new PublicAddressGuard(static fn (string $host): array => match ($host) {
            'ok.example' => ['93.184.216.34', '2606:4700::1'],
            'half.example' => ['93.184.216.34', 'fe80::1'],
            default => [],
        });
        self::assertSame(['93.184.216.34', '2606:4700::1'], $guard->vet(OutboundUrl::parse('https://ok.example/t')));
        self::assertSame(['203.0.113.9'], $guard->vet(OutboundUrl::parse('https://203.0.113.9/t')), 'an IP literal is not resolved');
        try {
            $guard->vet(OutboundUrl::parse('https://half.example/t'));
            self::fail('accepted a host with a link-local AAAA record');
        } catch (\Omw\Api\Infra\BlockedDestination $e) {
            self::assertStringContainsString('half.example resolves to a link-local address (fe80::1)', $e->getMessage());
        }
        $this->expectException(RuntimeException::class);
        $this->expectExceptionMessage('does not resolve');
        $guard->vet(OutboundUrl::parse('https://gone.example/t'));
    }

    /** @return iterable<string, array{bool}> */
    public static function transports(): iterable
    {
        yield 'curl' => [true];
        yield 'php streams' => [false];
    }

    #[DataProvider('transports')]
    public function testPinnedRequestsConnectToTheVettedAddress(bool $curl): void
    {
        if ($curl && !function_exists('curl_init')) {
            self::markTestSkipped('curl extension missing');
        }
        [$proc, $stdout, $port] = $this->startEchoServer();
        try {
            $client = new HttpClient($curl);
            $response = $client->request('POST', "http://ntfy-pin-test.invalid:$port/topic?x=1", ['Title' => 'hi'], 'body', 5.0, ['127.0.0.1']);
            self::assertSame(200, $response['status'], $response['body']);
            $seen = json_decode($response['body'], true);
            self::assertIsArray($seen);
            self::assertSame("ntfy-pin-test.invalid:$port", $seen['host'], 'the server sees the real host name');
            self::assertSame('POST /topic?x=1 HTTP/1.1', preg_replace('#HTTP/1\.[01]$#', 'HTTP/1.1', (string) $seen['requestLine']));
            self::assertSame('body', $seen['body']);

            // A literal address must be one of the vetted ones.
            try {
                $client->request('GET', "http://127.0.0.2:$port/", [], null, 5.0, ['127.0.0.1']);
                self::fail('connected to an address that was not vetted');
            } catch (RuntimeException $e) {
                self::assertStringContainsString('not vetted', $e->getMessage());
            }
        } finally {
            fclose($stdout);
            proc_terminate($proc);
            proc_close($proc);
        }
    }

    /**
     * A one-shot HTTP server on an ephemeral loopback port (child process) that answers with what
     * it received.
     *
     * @return array{0: resource, 1: resource, 2: int}
     */
    private function startEchoServer(): array
    {
        $script = $this->tmpDir() . '/echo-server.php';
        file_put_contents($script, <<<'PHP'
            <?php
            $server = stream_socket_server('tcp://127.0.0.1:0', $errno, $errstr);
            if ($server === false) { fwrite(STDERR, $errstr); exit(1); }
            fwrite(STDOUT, explode(':', (string) stream_socket_get_name($server, false))[1] . "\n");
            $conn = @stream_socket_accept($server, 15);
            if ($conn === false) { exit(1); }
            $raw = '';
            while (!str_contains($raw, "\r\n\r\n") && !feof($conn)) { $raw .= (string) fread($conn, 8192); }
            [$head, $body] = explode("\r\n\r\n", $raw, 2) + [1 => ''];
            $length = preg_match('/^Content-Length:\s*(\d+)/mi', $head, $m) === 1 ? (int) $m[1] : 0;
            while (strlen($body) < $length && !feof($conn)) { $body .= (string) fread($conn, 8192); }
            $out = json_encode([
                'host' => preg_match('/^Host:\s*(.+?)\s*$/mi', $head, $h) === 1 ? $h[1] : null,
                'requestLine' => strtok($head, "\r\n"),
                'body' => $body,
            ]);
            fwrite($conn, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: " . strlen((string) $out) . "\r\nConnection: close\r\n\r\n" . $out);
            fclose($conn);
            PHP);
        $proc = proc_open([PHP_BINARY, $script], [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes);
        if (!is_resource($proc)) {
            throw new RuntimeException('Cannot start the echo server');
        }
        fclose($pipes[0]);
        $line = fgets($pipes[1]);
        if (!is_string($line) || !ctype_digit(trim($line))) {
            throw new RuntimeException('Echo server did not start: ' . stream_get_contents($pipes[2]));
        }
        fclose($pipes[2]);

        return [$proc, $pipes[1], (int) trim($line)];
    }
}
