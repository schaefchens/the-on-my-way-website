<?php

declare(strict_types=1);

namespace Omw\Api\Http;

use Omw\Api\Http\Admin\CaptureController;
use Omw\Api\Http\Admin\DayController;
use Omw\Api\Http\Admin\PostController;
use Omw\Api\Http\Admin\SessionController;
use Omw\Api\Http\Admin\SettingsController;
use Omw\Api\Http\Admin\StatusController;
use Omw\Api\Http\Admin\TokenController;
use Omw\Api\Http\Admin\TripController;
use Omw\Api\Http\Backend\BackendController;
use Omw\Api\Http\Middleware\AdminAuth;
use Omw\Api\Http\Middleware\BackendAuth;
use Omw\Api\Http\Middleware\Cors;
use Psr\Http\Message\ResponseInterface;
use Slim\App;
use Slim\Interfaces\RouteCollectorProxyInterface;

/**
 * Route table of the API; each route has a stable name ("group.resource.action").
 *
 * Path parameters:
 *   {sourceKey}  capture key, e.g. "wa:3EB0C431D2A7F8E1" (contains a colon; URL-encode in clients)
 *   {publicId}   post id, "p_…"
 *   {localDate}  "YYYY-MM-DD"
 *   {slug}       trip slug, [a-z0-9-]+
 *
 * Auth:
 *   /api/v1/backend/*  Bearer token of kind "backend" with scope "backend" (Middleware\BackendAuth)
 *   /api/v1/admin/*    session token in the "__Host-omw_session" cookie + X-CSRF-Token header on
 *                      mutating requests (Domain\Auth\Csrf, derived from the session token), or a
 *                      Bearer token of kind "app" with scope "admin" (Middleware\AdminAuth)
 *   /api/v1/admin/session (POST) is the only unauthenticated admin endpoint (rate limited). ANY
 *   failure (unknown or malformed e-mail, wrong password, malformed body) is a generic 401 and is
 *   recorded in login_attempts.
 *   Mutating admin requests must send JSON bodies (RequireJsonBody, 415 otherwise).
 *   /api/v1/cron       CRON_KEY (X-Cron-Key header or ?key=), see CronController
 *
 * Bodies and responses follow packages/contracts (api/schemas/<Name>.json); the comment after
 * each route names them. Conventions from contracts api.ts: 422 "validation_failed", 409
 * "conflict" for a stale ifUpdatedAt, POST /posts idempotent per client publicId, DELETE of a
 * missing post = 204, change feed 409 "feed_reset" when after > max(seq) (Domain\ChangeLog).
 * Every owner write appends to change_log via Domain\ChangeLog::append() in the same transaction.
 */
final class Routes
{
    private const DATE = '{localDate:[0-9]{4}-[0-9]{2}-[0-9]{2}}';

    /** @param App<\Psr\Container\ContainerInterface> $app */
    public static function register(App $app): void
    {
        $app->get('/', RootAction::class)->setName('root'); // -> /admin/ when the admin PWA is deployed

        $app->group('/api/v1', function (RouteCollectorProxyInterface $v1): void {
            $v1->get('/health', HealthAction::class)->setName('health');
            $v1->map(['GET', 'POST'], '/cron', CronController::class)->setName('cron');

            $v1->group('/backend', function (RouteCollectorProxyInterface $g): void {
                $c = BackendController::class;
                $g->put('/captures/{sourceKey}', [$c, 'putCapture'])->setName('backend.captures.put');           // CaptureMirror -> 201|204
                $g->post('/captures/{sourceKey}/preview', [$c, 'preview'])->setName('backend.captures.preview'); // multipart role+file -> 204
                $g->post('/captures/{sourceKey}/revoke', [$c, 'revoke'])->setName('backend.captures.revoke');    // CaptureRevoke -> 204
                $g->get('/changes', [$c, 'changes'])->setName('backend.changes');                                 // ?after=&limit= -> ChangesResponse
                $g->post('/heartbeat', [$c, 'heartbeat'])->setName('backend.heartbeat');                          // Heartbeat -> 204
                $g->post('/published', [$c, 'published'])->setName('backend.published');                          // PublishedReport -> 204
                $g->get('/backup/latest', [$c, 'backupLatest'])->setName('backend.backup.latest');                // application/vnd.sqlite3
            })->add(BackendAuth::class);

            $v1->group('/admin', function (RouteCollectorProxyInterface $g): void {
                $g->post('/session', [SessionController::class, 'create'])->setName('admin.session.create'); // LoginRequest -> Me (+ cookie)
                $g->delete('/session', [SessionController::class, 'delete'])->setName('admin.session.delete'); // 204
                $g->get('/me', [SessionController::class, 'me'])->setName('admin.me');                       // Me

                $c = CaptureController::class;
                $g->get('/captures', [$c, 'list'])->setName('admin.captures.list');                       // ?CaptureListQuery -> CaptureListResponse
                $g->get('/captures/{sourceKey}', [$c, 'get'])->setName('admin.captures.get');            // CaptureListItem
                $g->patch('/captures/{sourceKey}', [$c, 'patch'])->setName('admin.captures.annotate');   // AnnotationPatch -> CaptureListItem
                $g->get('/captures/{sourceKey}/preview', [$c, 'preview'])->setName('admin.captures.preview'); // private 640w WebP (only if stored)
                $g->get('/captures/{sourceKey}/poster', [$c, 'poster'])->setName('admin.captures.poster');

                $p = PostController::class;
                $g->get('/posts', [$p, 'list'])->setName('admin.posts.list');                    // ?PostListQuery -> PostListResponse
                $g->post('/posts', [$p, 'create'])->setName('admin.posts.create');               // PostCreate -> AdminPost (201; 200 for a known publicId)
                $g->get('/posts/{publicId}', [$p, 'get'])->setName('admin.posts.get');          // AdminPost
                $g->patch('/posts/{publicId}', [$p, 'update'])->setName('admin.posts.update');  // PostUpdate -> AdminPost
                $g->delete('/posts/{publicId}', [$p, 'delete'])->setName('admin.posts.delete'); // 204 (also when already gone)

                $d = DayController::class;
                $g->get('/days', [$d, 'list'])->setName('admin.days.list');                      // DayListResponse
                $g->get('/days/' . self::DATE, [$d, 'get'])->setName('admin.days.get');         // AdminDayDetail
                $g->patch('/days/' . self::DATE, [$d, 'patch'])->setName('admin.days.update');  // DayPatch -> AdminDayDetail

                $t = TripController::class;
                $g->get('/trips', [$t, 'list'])->setName('admin.trips.list');                    // TripListResponse
                $g->get('/trips/{slug}', [$t, 'get'])->setName('admin.trips.get');              // AdminTrip
                $g->put('/trips/{slug}', [$t, 'put'])->setName('admin.trips.upsert');           // TripUpsert -> AdminTrip (422 on overlapping ranges)
                $g->delete('/trips/{slug}', [$t, 'delete'])->setName('admin.trips.delete');     // 204

                $g->get('/settings', [SettingsController::class, 'get'])->setName('admin.settings.get');      // Settings
                $g->patch('/settings', [SettingsController::class, 'patch'])->setName('admin.settings.update'); // SettingsPatch -> Settings

                $g->get('/status', [StatusController::class, 'status'])->setName('admin.status');   // StatusResponse
                $g->get('/doctor', [StatusController::class, 'doctor'])->setName('admin.doctor');   // {ok, checks} (not in contracts)

                $k = TokenController::class;
                $g->get('/tokens', [$k, 'list'])->setName('admin.tokens.list');                  // TokenListResponse (no session tokens)
                $g->post('/tokens', [$k, 'create'])->setName('admin.tokens.create');             // TokenCreate -> TokenCreated (201)
                $g->delete('/tokens/{id:[0-9]{1,18}}', [$k, 'revoke'])->setName('admin.tokens.revoke'); // 204
            })->add(AdminAuth::class)->add(RequireJsonBody::class);

            // Public visitor features (hearts, comments, subscriptions) come later under /api/v1/public.
            // CORS is already wired for the static site's origin (SITE_ORIGIN); preflights are answered here.
            $v1->group('/public', function (RouteCollectorProxyInterface $g): void {
                // Slim binds route closures to the container: this one must not be static.
                $g->options('/{path:.+}', fn ($request, ResponseInterface $response): ResponseInterface => $response->withStatus(204))
                    ->setName('public.preflight');
            })->add(Cors::class);
        });
    }
}
