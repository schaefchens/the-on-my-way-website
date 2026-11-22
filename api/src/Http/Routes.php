<?php

declare(strict_types=1);

namespace Omw\Api\Http;

use Omw\Api\Http\Admin\AccessController;
use Omw\Api\Http\Admin\CaptureController;
use Omw\Api\Http\Admin\DayController;
use Omw\Api\Http\Admin\DeviceController;
use Omw\Api\Http\Admin\FollowerController;
use Omw\Api\Http\Admin\NoticeController;
use Omw\Api\Http\Admin\PostController;
use Omw\Api\Http\Admin\PrivacyController;
use Omw\Api\Http\Admin\SessionController;
use Omw\Api\Http\Admin\SettingsController;
use Omw\Api\Http\Admin\StatusController;
use Omw\Api\Http\Admin\TokenController;
use Omw\Api\Http\Admin\TripController;
use Omw\Api\Http\App\AppRoutes;
use Omw\Api\Http\Backend\AccessSyncController;
use Omw\Api\Http\Backend\BackendController;
use Omw\Api\Http\Middleware\AdminAuth;
use Omw\Api\Http\Middleware\BackendAuth;
use Omw\Api\Http\Middleware\Cors;
use Omw\Api\Http\Middleware\PublicGuard;
use Omw\Api\Http\Public\JoinController;
use Omw\Api\Http\Public\MeController;
use Omw\Api\Http\Public\PanicController;
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
 *   {fid}        follower id, [a-z2-7]{12};  {did} device id, [a-z2-7]{8}
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
 *   /api/v1/cron       CRON_KEY (X-Cron-Key header, Authorization: Bearer, or ?key=), see CronController
 *   /api/v1/public/*   none (CORS for SITE_ORIGIN only, Middleware\Cors + PublicGuard): the device proves
 *                      itself with the link secret t or its key k in the text/plain JSON body (spec-wave5 §3.4)
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
    private const FID = '{fid:[a-z2-7]{12}}';
    private const DID = '{did:[a-z2-7]{8}}';

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

                $a = AccessSyncController::class;
                $g->post('/access/claim', [$a, 'claim'])->setName('backend.access.claim');                       // AccessClaimRequest -> AccessClaim
                $g->post('/access/renew', [$a, 'renew'])->setName('backend.access.renew');                       // AccessRenewRequest -> AccessLease
                $g->post('/access/listing', [$a, 'listing'])->setName('backend.access.listing');                 // StoreListingUpload -> AccessClaim
                $g->post('/access/ack', [$a, 'ack'])->setName('backend.access.ack');                             // AccessAck -> 204 | 409
                $g->get('/access/service-session', [$a, 'serviceSession'])->setName('backend.access.service');  // ?rotate=1 -> ServiceSession | 503 busy
            })->add(BackendAuth::class);

            $v1->group('/admin', function (RouteCollectorProxyInterface $g): void {
                $g->post('/session', [SessionController::class, 'create'])->setName('admin.session.create'); // LoginRequest -> Me (+ cookie)
                $g->delete('/session', [SessionController::class, 'delete'])->setName('admin.session.delete'); // 204
                $g->get('/me', [SessionController::class, 'me'])->setName('admin.me');                       // Me
                $g->put('/me/password', [SessionController::class, 'password'])->setName('admin.me.password'); // PasswordChange -> 204 (session only)

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

                $f = FollowerController::class;
                $g->get('/followers', [$f, 'list'])->setName('admin.followers.list');                          // FollowerListResponse
                $g->post('/followers', [$f, 'create'])->setName('admin.followers.create');                     // FollowerCreate -> FollowerCreated (201); 409 config_missing
                $g->get('/followers/' . self::FID, [$f, 'get'])->setName('admin.followers.get');               // AdminFollower
                $g->patch('/followers/' . self::FID, [$f, 'patch'])->setName('admin.followers.update');        // FollowerPatch -> AdminFollower
                $g->post('/followers/' . self::FID . '/link', [$f, 'link'])->setName('admin.followers.link');  // {} -> PersonalLinkCreated
                $g->post('/followers/' . self::FID . '/revoke', [$f, 'revoke'])->setName('admin.followers.revoke'); // {} -> AccessActionResult
                $g->get('/followers/' . self::FID . '/export', [$f, 'export'])->setName('admin.followers.export');  // FollowerDataExport (attachment)
                $g->post('/followers/' . self::FID . '/delete', [$f, 'delete'])->setName('admin.followers.delete'); // FollowerDeleteRequest -> AccessActionResult

                $dv = DeviceController::class;
                $g->post('/devices/' . self::DID . '/approve', [$dv, 'approve'])->setName('admin.devices.approve'); // {} -> AccessActionResult; 409 device_limit
                $g->post('/devices/' . self::DID . '/decline', [$dv, 'decline'])->setName('admin.devices.decline'); // {} -> AccessActionResult
                $g->post('/devices/' . self::DID . '/revoke', [$dv, 'revoke'])->setName('admin.devices.revoke');    // {} -> AccessActionResult

                $ac = AccessController::class;
                $g->get('/access', [$ac, 'status'])->setName('admin.access.status');                        // AccessStatus
                $g->post('/access/lock', [$ac, 'lock'])->setName('admin.access.lock');                      // LockRequest -> AccessActionResult
                $g->post('/access/retry', [$ac, 'retry'])->setName('admin.access.retry');                   // {} -> AccessStatus
                $g->post('/access/store-init', [$ac, 'storeInit'])->setName('admin.access.store_init');     // {} -> AccessActionResult
                $g->post('/access/panic-link', [$ac, 'createPanicLink'])->setName('admin.access.panic.create'); // {} -> PanicLinkCreated
                $g->delete('/access/panic-link', [$ac, 'deletePanicLink'])->setName('admin.access.panic.delete'); // 204

                $pv = PrivacyController::class;
                $g->get('/privacy', [$pv, 'get'])->setName('admin.privacy.get');                            // PrivacyState
                $g->put('/privacy/draft', [$pv, 'putDraft'])->setName('admin.privacy.draft');               // PrivacyNoticeDraft -> PrivacyState
                $g->post('/privacy/publish', [$pv, 'publish'])->setName('admin.privacy.publish');           // PrivacyPublishRequest -> PrivacyState; 422 notice_incomplete; 409

                $g->get('/notices', [NoticeController::class, 'list'])->setName('admin.notices.list');      // OwnerNoticeList
                $g->post('/notices/read', [NoticeController::class, 'read'])->setName('admin.notices.read'); // NoticeReadRequest -> 204
            })->add(AdminAuth::class)->add(RequireJsonBody::class);

            // Site -> API (spec-wave5 §3.4): text/plain JSON "simple requests", no cookies (F2 excepted).
            // Cors is the outermost layer so that every answer, errors included, carries the CORS headers.
            $v1->group('/public', function (RouteCollectorProxyInterface $g): void {
                $g->post('/join/check', [JoinController::class, 'check'])->setName('public.join.check');      // JoinCheckRequest -> JoinCheckResponse
                $g->post('/join', [JoinController::class, 'join'])->setName('public.join');                   // JoinRequest -> JoinResponse
                $g->post('/device/poll', [JoinController::class, 'poll'])->setName('public.device.poll');     // DeviceKeyRequest -> DevicePollResponse
                $m = MeController::class;
                $g->post('/me/hello', [$m, 'hello'])->setName('public.me.hello');                             // DeviceKeyRequest -> MeHelloResponse
                $g->post('/me/notice', [$m, 'notice'])->setName('public.me.notice');                          // DeviceKeyRequest -> MeNoticeResponse
                $g->post('/me/consent', [$m, 'consent'])->setName('public.me.consent');                       // MeConsentRequest -> MeHelloResponse
                $g->post('/me/data', [$m, 'data'])->setName('public.me.data');                                // DeviceKeyRequest -> MeDataResponse
                $g->post('/me/export', [$m, 'export'])->setName('public.me.export');                          // DeviceKeyRequest -> FollowerDataExport | MeSimpleResponse
                $g->post('/me/signout', [$m, 'signout'])->setName('public.me.signout');                       // DeviceKeyRequest -> MeSimpleResponse
                $g->post('/me/delete', [$m, 'delete'])->setName('public.me.delete');                          // MeDeleteRequest -> MeSimpleResponse
                $g->post('/panic', [PanicController::class, 'panic'])->setName('public.panic');               // PanicRequest -> PanicResponse
                // Slim binds route closures to the container: this one must not be static.
                $g->options('/{path:.+}', fn ($request, ResponseInterface $response): ResponseInterface => $response->withStatus(204))
                    ->setName('public.preflight');
            })->add(PublicGuard::class)->add(Cors::class);

            AppRoutes::register($v1); // traveler app: /app/*, /backend/app/*, /admin/app-* (Http\App\AppRoutes)
        });
    }
}
