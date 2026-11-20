<?php

declare(strict_types=1);

namespace Omw\Api\Http;

use Omw\Api\Config;
use Omw\Api\Domain\Auth\Sessions;
use Psr\Http\Message\ServerRequestInterface;

/**
 * Which cookie carries the admin session for a request.
 *
 * Always, except in the one case below: `__Host-omw_session` (Secure, HttpOnly, SameSite=Strict,
 * Path=/). Browsers only store a Secure cookie for an https page (Chromium and Firefox also for
 * http://localhost, Safari never), so the admin cannot log in against `php -S` over plain http.
 *
 * Local development fallback: the cookie `omw_dev_session` (HttpOnly, SameSite=Strict, Path=/,
 * NOT Secure) is used instead when ALL of these hold:
 *   1. DEV_INSECURE_COOKIE=true, which Config accepts only together with APP_ENV=development
 *      (any other APP_ENV refuses to start);
 *   2. the request is served by PHP's built-in web server (SAPI "cli-server"), which no
 *      production host runs (Apache/nginx + PHP-FPM report "fpm-fcgi", "apache2handler", …);
 *   3. the request came over plain http (not https);
 *   4. the client address is loopback (127.0.0.0/8 or ::1), e.g. a browser on the same machine
 *      or the admin dev server's proxy on 127.0.0.1:5174.
 * In that mode only the dev cookie is read; the CSRF header is required exactly as before.
 */
final class SessionCookie
{
    public const DEV_NAME = 'omw_dev_session';

    public function __construct(
        private readonly Config $config,
        private readonly string $sapi = PHP_SAPI,
    ) {
    }

    /** True when this request uses the insecure local-development cookie (see class doc). */
    public function insecureDev(ServerRequestInterface $request): bool
    {
        return $this->config->devInsecureCookie
            && $this->config->env === 'development'
            && $this->sapi === 'cli-server'
            && !Input::isHttps($request)
            && self::isLoopback(Input::clientIp($request));
    }

    public function name(ServerRequestInterface $request): string
    {
        return $this->insecureDev($request) ? self::DEV_NAME : Sessions::COOKIE;
    }

    /** The session token sent by the client, or null. */
    public function read(ServerRequestInterface $request): ?string
    {
        $value = $request->getCookieParams()[$this->name($request)] ?? null;

        return is_string($value) && $value !== '' ? $value : null;
    }

    /** Set-Cookie value that stores $token for $maxAge seconds. */
    public function issue(ServerRequestInterface $request, string $token, int $maxAge): string
    {
        if (!$this->insecureDev($request)) {
            return Sessions::cookie($token, $maxAge);
        }

        return sprintf('%s=%s; Max-Age=%d; Path=/; HttpOnly; SameSite=Strict', self::DEV_NAME, $token, $maxAge);
    }

    /** Set-Cookie value that deletes the session cookie. */
    public function clear(ServerRequestInterface $request): string
    {
        if (!$this->insecureDev($request)) {
            return Sessions::clearCookie();
        }

        return sprintf('%s=; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/; HttpOnly; SameSite=Strict', self::DEV_NAME);
    }

    public static function isLoopback(string $ip): bool
    {
        if ($ip === '::1') {
            return true;
        }
        if (str_starts_with(strtolower($ip), '::ffff:')) {
            $ip = substr($ip, 7);
        }

        return filter_var($ip, FILTER_VALIDATE_IP, FILTER_FLAG_IPV4) !== false && str_starts_with($ip, '127.');
    }
}
