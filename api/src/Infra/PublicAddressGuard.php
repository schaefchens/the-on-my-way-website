<?php

declare(strict_types=1);

namespace Omw\Api\Infra;

use Closure;
use RuntimeException;

/**
 * Keeps requests to admin-chosen URLs (alerts.ntfy_url) out of the host's own network: the host
 * must be, or resolve ONLY to, public addresses. Refused: loopback, unspecified, RFC 1918
 * private, CGNAT (RFC 6598), link-local, unique-local (fc00::/7), site-local, multicast and
 * reserved ranges, including IPv4 addresses embedded in IPv6 (IPv4-mapped, IPv4-compatible,
 * NAT64 64:ff9b::/96, 6to4 2002::/16). Every A and AAAA record is checked.
 *
 * {@see vet()} returns the vetted addresses; HttpClient pins the connection to them
 * (CURLOPT_RESOLVE), so a second DNS answer (DNS rebinding) cannot redirect the request, and it
 * never follows redirects.
 */
final class PublicAddressGuard
{
    /**
     * IPv4 ranges that are never a valid alert destination: [network, prefix length, label].
     * Documentation ranges (192.0.2.0/24, …) are not listed: they are not routed anyway.
     */
    private const V4_BLOCKED = [
        ['0.0.0.0', 8, 'unspecified ("this network")'],
        ['10.0.0.0', 8, 'private (RFC 1918)'],
        ['100.64.0.0', 10, 'carrier-grade NAT (RFC 6598)'],
        ['127.0.0.0', 8, 'loopback'],
        ['169.254.0.0', 16, 'link-local'],
        ['172.16.0.0', 12, 'private (RFC 1918)'],
        ['192.0.0.0', 24, 'IETF protocol assignments'],
        ['192.168.0.0', 16, 'private (RFC 1918)'],
        ['198.18.0.0', 15, 'benchmarking (RFC 2544)'],
        ['224.0.0.0', 4, 'multicast'],
        ['240.0.0.0', 4, 'reserved'],
    ];

    /** IPv6 ranges: [network, prefix length, label]. Embedded IPv4 is checked separately. */
    private const V6_BLOCKED = [
        ['::', 128, 'unspecified'],
        ['::1', 128, 'loopback'],
        ['100::', 64, 'discard-only (RFC 6666)'],
        ['fc00::', 7, 'unique-local (fc00::/7)'],
        ['fe80::', 10, 'link-local'],
        ['fec0::', 10, 'site-local'],
        ['ff00::', 8, 'multicast'],
    ];

    /** @var Closure(string): list<string> */
    private readonly Closure $resolver;

    /**
     * @param (callable(string): list<string>)|null $resolver host name -> IP addresses (default:
     *                                                       the system's A + AAAA records)
     */
    public function __construct(?callable $resolver = null)
    {
        $this->resolver = $resolver === null ? self::systemResolve(...) : Closure::fromCallable($resolver);
    }

    /**
     * The addresses the request may connect to (an IP literal stands for itself).
     *
     * @return non-empty-list<string>
     *
     * @throws BlockedDestination when any address is not public
     * @throws RuntimeException    when the host does not resolve
     */
    public function vet(OutboundUrl $url): array
    {
        $ips = $url->isIpLiteral() ? [$url->host] : array_values(array_unique(($this->resolver)($url->host)));
        if ($ips === []) {
            throw new RuntimeException(sprintf('%s does not resolve to any address', $url->host));
        }
        foreach ($ips as $ip) {
            $reason = self::blockedReason($ip);
            if ($reason !== null) {
                throw new BlockedDestination(sprintf(
                    'refused: %s %s a %s address (%s); alert URLs must point to the public internet',
                    $url->host,
                    $url->isIpLiteral() ? 'is' : 'resolves to',
                    $reason,
                    $ip,
                ));
            }
        }

        return $ips;
    }

    /** Why $ip is not a public destination, or null when it is one. Anything unparsable is refused. */
    public static function blockedReason(string $ip): ?string
    {
        $bin = @inet_pton($ip);
        if ($bin === false) {
            return 'unparsable';
        }
        if (strlen($bin) === 4) {
            return self::match($bin, self::V4_BLOCKED);
        }
        $reason = self::match($bin, self::V6_BLOCKED);
        if ($reason !== null) {
            return $reason;
        }
        $embedded = self::embeddedV4($bin);
        if ($embedded !== null) {
            $inner = self::match($embedded, self::V4_BLOCKED);

            return $inner === null ? null : $inner . ' (embedded in IPv6)';
        }

        return null;
    }

    /**
     * A and AAAA records via DNS plus the system resolver's IPv4 answer (/etc/hosts and
     * friends), so both views are checked.
     *
     * @return list<string>
     */
    public static function systemResolve(string $host): array
    {
        $ips = [];
        $records = @dns_get_record($host, DNS_A | DNS_AAAA);
        foreach (is_array($records) ? $records : [] as $record) {
            if (isset($record['ip']) && is_string($record['ip'])) {
                $ips[] = $record['ip'];
            }
            if (isset($record['ipv6']) && is_string($record['ipv6'])) {
                $ips[] = $record['ipv6'];
            }
        }
        $v4 = @gethostbynamel($host);
        foreach (is_array($v4) ? $v4 : [] as $ip) {
            $ips[] = $ip;
        }

        return array_values(array_unique($ips));
    }

    /** IPv4 address (4 bytes) carried inside an IPv6 address, for the transition formats. */
    private static function embeddedV4(string $bin16): ?string
    {
        $zero10 = str_repeat("\0", 10);
        if (str_starts_with($bin16, $zero10 . "\xff\xff")                       // ::ffff:a.b.c.d (mapped)
            || str_starts_with($bin16, $zero10 . "\0\0")                        // ::a.b.c.d (compatible)
            || str_starts_with($bin16, "\x00\x64\xff\x9b" . str_repeat("\0", 8))) { // 64:ff9b::/96 (NAT64)
            return substr($bin16, 12, 4);
        }
        if (str_starts_with($bin16, "\x20\x02")) {                              // 2002:aabb:ccdd::/48 (6to4)
            return substr($bin16, 2, 4);
        }

        return null;
    }

    /** @param list<array{0: string, 1: int, 2: string}> $ranges */
    private static function match(string $bin, array $ranges): ?string
    {
        foreach ($ranges as [$network, $prefix, $label]) {
            $net = (string) inet_pton($network);
            if (strlen($net) === strlen($bin) && self::inPrefix($bin, $net, $prefix)) {
                return $label;
            }
        }

        return null;
    }

    private static function inPrefix(string $bin, string $net, int $prefix): bool
    {
        $bytes = intdiv($prefix, 8);
        if (substr($bin, 0, $bytes) !== substr($net, 0, $bytes)) {
            return false;
        }
        $bits = $prefix % 8;
        if ($bits === 0) {
            return true;
        }
        $mask = (0xff << (8 - $bits)) & 0xff;

        return (ord($bin[$bytes]) & $mask) === (ord($net[$bytes]) & $mask);
    }
}
