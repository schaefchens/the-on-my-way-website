<?php

declare(strict_types=1);

namespace Omw\Api\Http\App;

use Omw\Api\Http\Middleware\AdminAuth;
use Omw\Api\Http\Middleware\BackendAuth;
use Omw\Api\Http\RequireJsonBody;
use Slim\Interfaces\RouteCollectorProxyInterface;

/**
 * Routes of the traveler app (app-plan §3.6), registered inside the /api/v1 group by
 * {@see \Omw\Api\Http\Routes} with one line, so the shared route table stays almost untouched.
 * Every name starts with "app." (wave 5 uses followers/devices/access).
 *
 * Auth per group:
 *   /app/pair             none (rate-limited like the admin login)
 *   /app/*                capture token of a connected phone ({@see AppAuth}); no CORS (native app)
 *   /backend/app/*        backend token (BackendAuth)
 *   /admin/app-*          admin session (AdminAuth + RequireJsonBody)
 */
final class AppRoutes
{
    private const ENTRY = '{entryId:[0-9A-Za-z]{26}}';
    private const UPLOAD = '{uploadId:u_[A-Za-z0-9_-]{16,64}}';

    /** @param RouteCollectorProxyInterface<\Psr\Container\ContainerInterface|null> $v1 */
    public static function register(RouteCollectorProxyInterface $v1): void
    {
        $c = AppController::class;
        $v1->post('/app/pair', [$c, 'pair'])->setName('app.pair');

        $v1->group('/app', function (RouteCollectorProxyInterface $g) use ($c): void {
            $g->post('/entries', [$c, 'create'])->setName('app.entries.create');
            $g->get('/entries', [$c, 'list'])->setName('app.entries.list');
            $g->get('/entries/' . self::ENTRY, [$c, 'get'])->setName('app.entries.get');
            $g->delete('/entries/' . self::ENTRY, [$c, 'withdraw'])->setName('app.entries.withdraw');
            $g->post('/entries/' . self::ENTRY . '/commit', [$c, 'commit'])->setName('app.entries.commit');
            $g->map(['HEAD'], '/uploads/' . self::UPLOAD, [$c, 'head'])->setName('app.uploads.head');
            $g->patch('/uploads/' . self::UPLOAD, [$c, 'patch'])->setName('app.uploads.patch');
            $g->delete('/uploads/' . self::UPLOAD, [$c, 'abandon'])->setName('app.uploads.abandon');
            $g->put('/visibility/{sourceKey}', [$c, 'visibility'])->setName('app.visibility');
            $g->get('/hints', [$c, 'hints'])->setName('app.hints');
        })->add(AppAuth::class);

        $v1->group('/backend/app', function (RouteCollectorProxyInterface $g): void {
            $b = AppBackendController::class;
            $g->get('/entries', [$b, 'entries'])->setName('app.backend.entries');
            $g->get('/uploads/' . self::UPLOAD . '/content', [$b, 'content'])->setName('app.backend.content');
            $g->post('/entries/' . self::ENTRY . '/ack', [$b, 'ack'])->setName('app.backend.ack');
            $g->post('/entries/' . self::ENTRY . '/reject', [$b, 'reject'])->setName('app.backend.reject');
        })->add(BackendAuth::class);

        $v1->group('/admin', function (RouteCollectorProxyInterface $g): void {
            $a = AppAdminController::class;
            $g->post('/app-pairings', [$a, 'createPairing'])->setName('app.admin.pairings.create');
            $g->get('/app-phones', [$a, 'phones'])->setName('app.admin.phones.list');
            $g->delete('/app-phones/{id:[0-9]{1,18}}', [$a, 'disconnect'])->setName('app.admin.phones.disconnect');
            $g->get('/app-entries/{sourceKey}', [$a, 'entry'])->setName('app.admin.entries.get');
        })->add(AdminAuth::class)->add(RequireJsonBody::class);
    }
}
