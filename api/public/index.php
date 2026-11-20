<?php

/**
 * Front controller (Apache: see .htaccess; nginx: try_files $uri $uri/ /index.php?$query_string).
 *
 * Also works as router script for PHP's built-in server:
 *   php -S 127.0.0.1:8080 -t public public/index.php      (composer serve)
 */

declare(strict_types=1);

// Never advertise the exact PHP build (hosts with expose_php=On add "X-Powered-By: PHP/8.x.y" to
// every response; expose_php is a php.ini-only setting, so it cannot be switched off from here).
header_remove('X-Powered-By');

if (PHP_SAPI === 'cli-server') {
    $uriPath = parse_url(is_string($_SERVER['REQUEST_URI'] ?? null) ? $_SERVER['REQUEST_URI'] : '/', PHP_URL_PATH);
    $uriPath = rawurldecode(is_string($uriPath) ? $uriPath : '/');
    $isHidden = preg_match('#(^|/)\.#', $uriPath) === 1 || str_contains($uriPath, "\0");

    $isAdmin = $uriPath === '/admin' || str_starts_with($uriPath, '/admin/');
    if ($isAdmin) {
        // Mirrors .htaccess: no framing, shell/sw/manifest revalidated, hashed assets immutable.
        header('X-Frame-Options: DENY');
        header("Content-Security-Policy: frame-ancestors 'none'");
        if (preg_match('#^/admin/(?:sw\.js|index\.html|manifest\.webmanifest)?$#', $uriPath) === 1) {
            header('Cache-Control: no-cache');
        } elseif (str_starts_with($uriPath, '/admin/assets/')) {
            header('Cache-Control: public, max-age=31536000, immutable');
        }
    }
    // Existing static files (e.g. the built admin PWA) are served by the built-in server itself.
    if (!$isHidden && $uriPath !== '/' && is_file(__DIR__ . $uriPath) && $uriPath !== '/index.php') {
        return false;
    }
    // A missing hashed admin asset is a real 404, never the SPA shell (service worker caching).
    if (str_starts_with($uriPath, '/admin/assets/')) {
        http_response_code(404);
        header('Content-Type: text/plain; charset=utf-8');
        echo "Not found\n";

        return true;
    }
    // Admin PWA: /admin -> /admin/, unknown /admin/* paths -> SPA shell (mirrors .htaccess).
    if (!$isHidden && $isAdmin && is_file(__DIR__ . '/admin/index.html')) {
        if ($uriPath === '/admin') {
            header('Location: /admin/', true, 301);

            return true;
        }
        header('Content-Type: text/html; charset=utf-8');
        readfile(__DIR__ . '/admin/index.html');

        return true;
    }
}

// scripts/deploy-api.ts uploads ../.maintenance while it replaces PHP files, so no request runs on
// a half-updated code base. (Dotfiles are never served; see ../.htaccess.)
if (is_file(dirname(__DIR__) . '/.maintenance')) {
    http_response_code(503);
    header('Retry-After: 15');
    header('Cache-Control: no-store');
    header('Content-Type: application/json; charset=utf-8');
    echo '{"error":{"code":"maintenance","message":"A deploy is in progress. Try again in a few seconds."}}';

    return;
}

// Errors must never be echoed into JSON responses; they are logged and rendered by JsonErrorHandler.
ini_set('display_errors', '0');
set_error_handler(static function (int $severity, string $message, string $file, int $line): bool {
    if ((error_reporting() & $severity) === 0 || $severity === E_DEPRECATED || $severity === E_USER_DEPRECATED) {
        return false; // fall through to PHP's own handling (logged, not fatal)
    }
    throw new ErrorException($message, 0, $severity, $file, $line);
});

$root = dirname(__DIR__);
if (!is_file($root . '/vendor/autoload.php')) {
    http_response_code(500);
    header('Content-Type: application/json; charset=utf-8');
    echo '{"error":{"code":"not_installed","message":"Dependencies missing: run composer install in api/."}}';

    return;
}

require $root . '/vendor/autoload.php';

Omw\Api\App::fromEnvironment($root)->run();
