<?php

declare(strict_types=1);

namespace Omw\Api\Infra;

use RuntimeException;

/**
 * Minimal outgoing HTTP (ntfy alerts, doctor self-check): curl when available, PHP streams
 * otherwise. Never follows redirects; TLS certificates are verified.
 *
 * $pinnedIps (from {@see PublicAddressGuard::vet()}) makes the request connect only to those
 * addresses, whatever DNS answers in the meantime: curl gets them through CURLOPT_RESOLVE, the
 * stream fallback connects to the first one directly (Host header and TLS peer name stay the
 * URL's host).
 */
class HttpClient
{
    public function __construct(private readonly bool $useCurl = true)
    {
    }

    /**
     * @param non-empty-string        $method
     * @param array<string, string>   $headers
     * @param list<string>|null       $pinnedIps connect only to these addresses (the URL's host must be a name or one of them)
     * @return array{status: int, body: string}
     *
     * @throws RuntimeException on transport errors (DNS, TLS, timeout)
     */
    public function request(string $method, string $url, array $headers = [], ?string $body = null, float $timeout = 10.0, ?array $pinnedIps = null): array
    {
        if ($url === '' || preg_match('#^https?://#i', $url) !== 1) {
            throw new RuntimeException('Only http(s) URLs are supported.');
        }
        $lines = [];
        foreach ($headers as $name => $value) {
            $lines[] = $name . ': ' . str_replace(["\r", "\n"], ' ', $value);
        }
        $lines[] = 'User-Agent: omw-api';
        $pin = null;
        if ($pinnedIps !== null) {
            $pin = self::pinTarget($url, $pinnedIps);
        }

        if ($this->useCurl && function_exists('curl_init')) {
            $ch = curl_init($url);
            curl_setopt_array($ch, [
                CURLOPT_CUSTOMREQUEST => $method,
                CURLOPT_HTTPHEADER => $lines,
                CURLOPT_RETURNTRANSFER => true,
                CURLOPT_FOLLOWLOCATION => false,
                CURLOPT_CONNECTTIMEOUT_MS => (int) ($timeout * 1000),
                CURLOPT_TIMEOUT_MS => (int) ($timeout * 1000),
                CURLOPT_PROTOCOLS => CURLPROTO_HTTP | CURLPROTO_HTTPS,
            ]);
            if ($method === 'HEAD') {
                curl_setopt($ch, CURLOPT_NOBODY, true);
            }
            if ($pin !== null && $pin['host'] !== null) {
                $addresses = implode(',', array_map(static fn (string $ip): string => str_contains($ip, ':') ? '[' . $ip . ']' : $ip, $pin['ips']));
                curl_setopt($ch, CURLOPT_RESOLVE, [$pin['host'] . ':' . $pin['port'] . ':' . $addresses]);
            }
            if ($body !== null) {
                curl_setopt($ch, CURLOPT_POSTFIELDS, $body);
            }
            $result = curl_exec($ch);
            if (!is_string($result)) {
                $error = curl_error($ch);
                throw new RuntimeException('HTTP request failed: ' . ($error !== '' ? $error : 'unknown error'));
            }

            return ['status' => (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE), 'body' => $result];
        }

        $options = [
            'http' => [
                'method' => $method,
                'header' => implode("\r\n", $lines),
                'content' => $body ?? '',
                'timeout' => $timeout,
                'ignore_errors' => true,
                'follow_location' => 0,
                'max_redirects' => 0,
            ],
        ];
        if ($pin !== null && $pin['host'] !== null) {
            // Connect to the vetted address; the server still sees (and TLS still verifies) the host name.
            $ip = $pin['ips'][0];
            $hostPort = $pin['host'] . ($pin['explicitPort'] ? ':' . $pin['port'] : '');
            $url = (string) preg_replace('#^(https?://)[^/?\#]+#i', '${1}' . (str_contains($ip, ':') ? '[' . $ip . ']' : $ip) . ':' . $pin['port'], $url);
            $options['http']['header'] .= "\r\nHost: " . $hostPort;
            $options['ssl'] = ['peer_name' => $pin['host'], 'SNI_enabled' => true];
        }
        $context = stream_context_create($options);
        $http_response_header = [];
        $result = @file_get_contents($url, false, $context);
        $status = 0;
        foreach ($http_response_header as $line) {
            if (preg_match('#^HTTP/\S+\s+(\d{3})#', $line, $m) === 1) {
                $status = (int) $m[1];
            }
        }
        if ($result === false && $status === 0) {
            throw new RuntimeException('HTTP request failed: ' . (error_get_last()['message'] ?? 'unknown error'));
        }

        return ['status' => $status, 'body' => $result === false ? '' : $result];
    }

    /**
     * @param list<string> $ips
     * @return array{host: string|null, port: int, explicitPort: bool, ips: non-empty-list<string>} host null: the URL names an IP itself
     */
    private static function pinTarget(string $url, array $ips): array
    {
        if ($ips === []) {
            throw new RuntimeException('No address to connect to.');
        }
        $parts = parse_url($url);
        if (!is_array($parts) || !isset($parts['scheme'], $parts['host'])) {
            throw new RuntimeException('Invalid URL.');
        }
        $host = trim(strtolower($parts['host']), '[]');
        $port = $parts['port'] ?? (strtolower($parts['scheme']) === 'https' ? 443 : 80);
        if (filter_var($host, FILTER_VALIDATE_IP) !== false) {
            if (!in_array(inet_pton($host), array_map(static fn (string $ip): string|false => @inet_pton($ip), $ips), true)) {
                throw new RuntimeException('The URL names an address that was not vetted.');
            }

            return ['host' => null, 'port' => $port, 'explicitPort' => isset($parts['port']), 'ips' => array_values($ips)];
        }

        return ['host' => $host, 'port' => $port, 'explicitPort' => isset($parts['port']), 'ips' => array_values($ips)];
    }
}
