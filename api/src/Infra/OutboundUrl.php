<?php

declare(strict_types=1);

namespace Omw\Api\Infra;

use InvalidArgumentException;

/**
 * An http(s) URL for an outgoing request to an address someone other than the operator chose
 * (the admin's alerts.ntfy_url), parsed once and rebuilt from its parts, so the host that is
 * checked ({@see PublicAddressGuard}), the origin a token is bound to and the URL curl receives
 * can never disagree (no parser differentials through user info, backslashes, odd ports, …).
 */
final class OutboundUrl
{
    private const HOST_RE = '/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/D';

    /**
     * @param string $host lowercase DNS name or IP literal (IPv6 without brackets)
     * @param string $rest path + query, starting with "/"
     */
    private function __construct(
        public readonly string $scheme,
        public readonly string $host,
        public readonly int $port,
        public readonly string $rest,
    ) {
    }

    /** @throws InvalidArgumentException with a message that can be shown to the owner */
    public static function parse(string $url): self
    {
        if (preg_match('#^https?://#i', $url) !== 1 || preg_match('/[\s\\\\\x00-\x1f\x7f]/', $url) === 1) {
            throw new InvalidArgumentException('must be a plain http(s) URL');
        }
        $parts = parse_url($url);
        if (!is_array($parts) || !isset($parts['scheme'], $parts['host']) || $parts['host'] === '') {
            throw new InvalidArgumentException('must be a plain http(s) URL');
        }
        if (isset($parts['user']) || isset($parts['pass'])) {
            throw new InvalidArgumentException('must not contain a user name or password (ntfy access tokens go into NTFY_TOKEN)');
        }
        $scheme = strtolower($parts['scheme']);
        $host = strtolower($parts['host']);
        if (str_ends_with($host, '.') && !str_ends_with($host, '..')) {
            $host = substr($host, 0, -1); // "ntfy.sh." (fully qualified) is "ntfy.sh"
        }
        if (str_starts_with($host, '[') && str_ends_with($host, ']')) {
            $host = substr($host, 1, -1);
            if (filter_var($host, FILTER_VALIDATE_IP, FILTER_FLAG_IPV6) === false) {
                throw new InvalidArgumentException('has an invalid IPv6 address');
            }
        } elseif (filter_var($host, FILTER_VALIDATE_IP, FILTER_FLAG_IPV4) === false
            // A numeric last label ("127.1", "2130706433", "0x7f.1") is no DNS name: resolvers
            // read it as a shorthand IPv4 address, so only the dotted-quad form is accepted.
            && (preg_match(self::HOST_RE, $host) !== 1 || preg_match('/(?:^|\.)(?:\d+|0x[0-9a-f]*)$/D', $host) === 1)) {
            throw new InvalidArgumentException('has an invalid host name');
        }
        $port = $parts['port'] ?? ($scheme === 'https' ? 443 : 80);
        if ($port < 1 || $port > 65535) {
            throw new InvalidArgumentException('has an invalid port');
        }
        $rest = ($parts['path'] ?? '') === '' ? '/' : $parts['path'];
        if (isset($parts['query'])) {
            $rest .= '?' . $parts['query'];
        }

        return new self($scheme, $host, $port, $rest);
    }

    public function isIpLiteral(): bool
    {
        return filter_var($this->host, FILTER_VALIDATE_IP) !== false;
    }

    /** "https://ntfy.sh", "http://example.org:8080" (default ports omitted). */
    public function origin(): string
    {
        $host = str_contains($this->host, ':') ? '[' . $this->host . ']' : $this->host;
        $default = $this->scheme === 'https' ? 443 : 80;

        return $this->scheme . '://' . $host . ($this->port === $default ? '' : ':' . $this->port);
    }

    public function toString(): string
    {
        return $this->origin() . $this->rest;
    }

    /** Origin of an operator-configured URL ("https://ntfy.sh/" -> "https://ntfy.sh"), or null when it is not a usable http(s) URL. */
    public static function originOf(string $url): ?string
    {
        try {
            return self::parse($url)->origin();
        } catch (InvalidArgumentException) {
            return null;
        }
    }
}
