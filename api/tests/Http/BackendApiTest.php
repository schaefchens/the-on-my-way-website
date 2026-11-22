<?php

declare(strict_types=1);

namespace Omw\Api\Tests\Http;

use Omw\Api\Domain\Auth\ApiTokens;
use Omw\Api\Infra\Backups;
use Omw\Api\Infra\Clock;
use Omw\Api\Infra\Db;
use Slim\Psr7\Factory\StreamFactory;
use Slim\Psr7\UploadedFile;

/**
 * /api/v1/backend/*: auth, capture mirror (idempotent, sticky revoke, owner data untouched),
 * previews (limits, types, 404 before the mirror), change feed (paging, tombstones, feed reset),
 * heartbeat, publish reports, backup download.
 */
final class BackendApiTest extends ApiTestCase
{
    private const WEBP = "RIFF\x24\x00\x00\x00WEBPVP8 \x18\x00\x00\x00\x30\x01\x00\x9d\x01\x2a\x01\x00\x01\x00\x02\x00\x34\x25\xa4\x00\x03\x70\x00\xfe\xfb\x94\x00\x00";

    public function testRequiresABackendToken(): void
    {
        $this->migrate();
        self::assertError($this->request('GET', '/api/v1/backend/changes'), 401, 'unauthorized');
        self::assertError($this->request('GET', '/api/v1/backend/changes', null, ['Authorization' => 'Bearer omw_' . str_repeat('a', 43)]), 401, 'unauthorized');
        self::assertStringContainsString('Bearer', $this->request('GET', '/api/v1/backend/changes')->getHeaderLine('WWW-Authenticate'));

        // A valid admin app token is not a backend token.
        $userId = $this->createAdmin();
        $app = $this->service(ApiTokens::class)->create('app', 'phone', null, $userId)['token'];
        self::assertError($this->request('GET', '/api/v1/backend/changes', null, ['Authorization' => 'Bearer ' . $app]), 403, 'forbidden');

        // Revoked and expired tokens stop working.
        $tokens = $this->service(ApiTokens::class);
        $revoked = $tokens->create('backend', 'old');
        $tokens->revoke($revoked['id']);
        self::assertError($this->request('GET', '/api/v1/backend/changes', null, ['Authorization' => 'Bearer ' . $revoked['token']]), 401, 'unauthorized');
        $expiring = $tokens->create('backend', 'short', null, null, '2026-11-20T11:00:00.000Z');
        self::assertSame(200, $this->request('GET', '/api/v1/backend/changes', null, ['Authorization' => 'Bearer ' . $expiring['token']])->getStatusCode());
        Clock::advance('+2 hours');
        self::assertError($this->request('GET', '/api/v1/backend/changes', null, ['Authorization' => 'Bearer ' . $expiring['token']]), 401, 'unauthorized');
    }

    public function testTokenUseIsRecordedViaRedirectedAuthorizationHeader(): void
    {
        // Apache + PHP-FPM: the header only arrives as REDIRECT_HTTP_AUTHORIZATION (see .htaccess).
        $token = $this->backendToken();
        $response = $this->request('GET', '/api/v1/backend/changes', null, [], [], ['REDIRECT_HTTP_AUTHORIZATION' => 'Bearer ' . $token]);
        self::assertSame(200, $response->getStatusCode());
        $lastUsed = $this->service(Db::class)->scalar("SELECT last_used_at FROM api_tokens WHERE kind = 'backend'");
        self::assertSame(self::NOW, $lastUsed);
    }

    public function testCaptureMirrorIsIdempotentAndNeverTouchesOwnerData(): void
    {
        $body = self::capture('3EB0AAA1', '2026-11-18T02:00:00Z');
        $url = '/api/v1/backend/captures/' . rawurlencode((string) $body['sourceKey']);

        self::assertSame(201, $this->backend('PUT', $url, $body)->getStatusCode());
        self::assertSame(204, $this->backend('PUT', $url, $body)->getStatusCode(), 'replay');
        $db = $this->service(Db::class);
        self::assertSame(1, (int) $db->scalar('SELECT COUNT(*) FROM captures'));
        self::assertSame('2026-11-18T02:00:00.000Z', $db->scalar('SELECT occurred_at FROM captures'), 'instants are stored canonically');

        // Owner annotates; a later mirror update (e.g. media finished) must keep the annotation.
        $patch = $this->admin('PATCH', '/api/v1/admin/captures/wa%3A3EB0AAA1', ['visibility' => 'hidden', 'description' => ['de' => 'Laternen']]);
        self::assertSame(200, $patch->getStatusCode(), (string) $patch->getBody());
        $seqBefore = (int) $db->scalar('SELECT MAX(seq) FROM change_log');
        self::assertSame(204, $this->backend('PUT', $url, ['caption' => 'Lanterns at night', 'mediaState' => 'ok'] + $body)->getStatusCode());
        self::assertSame('hidden', $db->scalar('SELECT visibility FROM annotations'));
        self::assertSame('Lanterns at night', $db->scalar('SELECT caption FROM captures'));
        self::assertSame($seqBefore, (int) $db->scalar('SELECT MAX(seq) FROM change_log'), 'mirror writes never enter the owner change feed');
    }

    public function testCaptureMirrorValidation(): void
    {
        $body = self::capture('3EB0AAA2', '2026-11-18T02:00:00Z');
        $url = '/api/v1/backend/captures/wa%3A3EB0AAA2';

        self::assertError($this->backend('PUT', $url, ['kind' => 'sticker'] + $body), 422, 'validation_failed');
        self::assertError($this->backend('PUT', $url, ['tz' => 'Mars/Olympus'] + $body), 422, 'validation_failed');
        self::assertError($this->backend('PUT', $url, ['tz' => '+07:00'] + $body), 422, 'validation_failed');
        self::assertError($this->backend('PUT', $url, ['publicId' => 'e_aaaaaaaaaaaa'] + $body), 422, 'validation_failed');
        self::assertError($this->backend('PUT', $url, ['contractVersion' => 2] + $body), 422, 'validation_failed');
        self::assertError($this->backend('PUT', $url, ['unknownField' => 1] + $body), 422, 'validation_failed');
        self::assertError($this->backend('PUT', '/api/v1/backend/captures/wa%3AOTHER', $body), 422, 'validation_failed');
        self::assertError($this->backend('PUT', $url, '{not json'), 422, 'validation_failed');
        $response = $this->request('PUT', $url, (string) json_encode($body), ['Authorization' => 'Bearer ' . $this->backendToken(), 'Content-Type' => 'text/plain']);
        self::assertError($response, 415, 'unsupported_media_type');
        self::assertSame(0, (int) $this->service(Db::class)->scalar('SELECT COUNT(*) FROM captures'));
    }

    public function testRevokedAtIsSticky(): void
    {
        $sourceKey = $this->putCapture('3EB0AAA3', '2026-11-18T02:00:00Z', ['revokedAt' => '2026-11-18T03:00:00Z']);
        $db = $this->service(Db::class);
        self::assertSame('2026-11-18T03:00:00.000Z', $db->scalar('SELECT revoked_at FROM captures'));

        // A later PUT without revokedAt (or with another one) never clears/moves it.
        $this->putCapture('3EB0AAA3', '2026-11-18T02:00:00Z', ['revokedAt' => null]);
        $this->putCapture('3EB0AAA3', '2026-11-18T02:00:00Z');
        $this->putCapture('3EB0AAA3', '2026-11-18T02:00:00Z', ['revokedAt' => '2026-11-19T00:00:00Z']);
        $afterPuts = $db->scalar('SELECT revoked_at FROM captures');
        self::assertSame('2026-11-18T03:00:00.000Z', $afterPuts);

        $url = '/api/v1/backend/captures/' . rawurlencode($sourceKey) . '/revoke';
        self::assertSame(204, $this->backend('POST', $url, ['contractVersion' => 1, 'at' => '2026-11-20T00:00:00Z'])->getStatusCode());
        self::assertSame('2026-11-18T03:00:00.000Z', $db->scalar('SELECT revoked_at FROM captures'));
    }

    public function testPurgeEndpointRemovesTheCaptureItsPreviewsAndAnnotation(): void
    {
        $sourceKey = $this->putCapture('3EB0AAB1', '2026-11-18T02:00:00Z', ['kind' => 'video', 'media' => ['w' => 720, 'h' => 1280, 'duration' => 5]]);
        $other = $this->putCapture('3EB0AAB2', '2026-11-18T03:00:00Z');
        $url = '/api/v1/backend/captures/' . rawurlencode($sourceKey);
        self::assertSame(204, $this->upload($url . '/preview', 'preview', self::WEBP)->getStatusCode());
        self::assertSame(204, $this->upload($url . '/preview', 'poster', self::jpeg())->getStatusCode());
        self::assertSame(200, $this->admin('PATCH', '/api/v1/admin/captures/' . rawurlencode($sourceKey), ['visibility' => 'hidden'])->getStatusCode());
        self::assertCount(2, glob($this->tmpDir() . '/var/previews/*/*') ?: []);

        self::assertError($this->request('DELETE', $url), 401, 'unauthorized');
        self::assertSame(204, $this->backend('DELETE', $url)->getStatusCode());

        $db = $this->service(Db::class);
        self::assertNull($db->scalar('SELECT 1 FROM captures WHERE source_key = ?', [$sourceKey]));
        self::assertNull($db->scalar('SELECT 1 FROM annotations WHERE source_key = ?', [$sourceKey]));
        self::assertSame([], glob($this->tmpDir() . '/var/previews/*/*') ?: []);
        self::assertSame(404, $this->admin('GET', '/api/v1/admin/captures/' . rawurlencode($sourceKey))->getStatusCode());
        // The annotation leaves a tombstone on the change feed; the other capture is untouched.
        $changes = self::json($this->backend('GET', '/api/v1/backend/changes?after=0'));
        $last = end($changes['items']);
        self::assertSame(['annotation', $sourceKey, 'delete'], [$last['entity'], $last['key'], $last['op']]);
        self::assertSame(200, $this->admin('GET', '/api/v1/admin/captures/' . rawurlencode($other))->getStatusCode());

        // Idempotent, and the source key is validated.
        self::assertSame(204, $this->backend('DELETE', $url)->getStatusCode());
        self::assertError($this->backend('DELETE', '/api/v1/backend/captures/nope'), 422, 'validation_failed');
    }

    public function testRevokeEndpoint(): void
    {
        self::assertError($this->backend('POST', '/api/v1/backend/captures/wa%3ANOPE/revoke', ['contractVersion' => 1, 'at' => '2026-11-20T00:00:00Z']), 404, 'capture_not_mirrored');
        $sourceKey = $this->putCapture('3EB0AAA4', '2026-11-18T02:00:00Z');
        $url = '/api/v1/backend/captures/' . rawurlencode($sourceKey) . '/revoke';
        self::assertError($this->backend('POST', $url, ['contractVersion' => 1]), 422, 'validation_failed');
        self::assertSame(204, $this->backend('POST', $url, ['contractVersion' => 1, 'at' => '2026-11-19T00:00:00Z'])->getStatusCode());
        self::assertSame('2026-11-19T00:00:00.000Z', $this->service(Db::class)->scalar('SELECT revoked_at FROM captures'));

        // ingest.on_revoke = hide (default) -> effectively hidden for the admin.
        $item = self::json($this->admin('GET', '/api/v1/admin/captures/' . rawurlencode($sourceKey)));
        self::assertSame('hidden', $item['effectiveVisibility']);
        self::assertSame('2026-11-19T00:00:00.000Z', $item['revokedAt']);
    }

    public function testPreviewUpload(): void
    {
        $url = '/api/v1/backend/captures/wa%3A3EB0AAA5/preview';
        self::assertError($this->upload($url, 'preview', self::WEBP), 404, 'capture_not_mirrored');

        $this->putCapture('3EB0AAA5', '2026-11-18T02:00:00Z', ['kind' => 'video', 'media' => ['w' => 720, 'h' => 1280, 'duration' => 12.5]]);
        self::assertSame(204, $this->upload($url, 'preview', self::WEBP)->getStatusCode());
        self::assertSame(204, $this->upload($url, 'poster', self::jpeg())->getStatusCode());

        $item = self::json($this->admin('GET', '/api/v1/admin/captures/wa%3A3EB0AAA5'));
        self::assertIsString($item['previewUrl']);
        self::assertIsString($item['posterUrl']);
        self::assertMatchesRegularExpression('#^/api/v1/admin/captures/wa%3A3EB0AAA5/preview\?v=[0-9a-f]{8}$#', $item['previewUrl']);

        // The admin can fetch it (private cache); without a session it is 401.
        $image = $this->admin('GET', $item['previewUrl']);
        self::assertSame(200, $image->getStatusCode());
        self::assertSame('image/webp', $image->getHeaderLine('Content-Type'));
        self::assertSame(self::WEBP, (string) $image->getBody());
        self::assertStringStartsWith('private, max-age=31536000', $image->getHeaderLine('Cache-Control'));
        self::assertSame(304, $this->admin('GET', $item['previewUrl'], null, ['If-None-Match' => $image->getHeaderLine('ETag')])->getStatusCode());
        self::assertError($this->request('GET', $item['previewUrl']), 401, 'unauthorized');
        self::assertSame('image/jpeg', $this->admin('GET', (string) $item['posterUrl'])->getHeaderLine('Content-Type'));

        // Re-uploading replaces the file (new version, old file removed).
        $files = glob($this->tmpDir() . '/var/previews/*/*_preview_*') ?: [];
        self::assertCount(1, $files);
        self::assertSame(204, $this->upload($url, 'preview', self::WEBP . 'x')->getStatusCode());
        $after = glob($this->tmpDir() . '/var/previews/*/*_preview_*') ?: [];
        self::assertCount(1, $after);
        self::assertNotSame($files[0], $after[0]);
        self::assertNotSame($item['previewUrl'], self::json($this->admin('GET', '/api/v1/admin/captures/wa%3A3EB0AAA5'))['previewUrl']);
    }

    public function testPreviewUploadLimits(): void
    {
        $this->putCapture('3EB0AAA6', '2026-11-18T02:00:00Z');
        $url = '/api/v1/backend/captures/wa%3A3EB0AAA6/preview';

        self::assertError($this->upload($url, 'preview', self::WEBP . str_repeat("\0", 512 * 1024)), 413, 'payload_too_large');
        self::assertError($this->upload($url, 'preview', self::WEBP, UPLOAD_ERR_INI_SIZE), 413, 'payload_too_large');
        self::assertError($this->upload($url, 'preview', "\x89PNG\r\n\x1a\n" . str_repeat("\0", 64)), 415, 'unsupported_media_type');
        self::assertError($this->upload($url, 'preview', 'GIF89a' . str_repeat("\0", 64)), 415, 'unsupported_media_type');
        self::assertError($this->upload($url, 'thumbnail', self::WEBP), 422, 'validation_failed');
        self::assertError($this->upload($url, 'preview', ''), 422, 'validation_failed');
        $noFile = $this->request('POST', $url, ['role' => 'preview'], ['Authorization' => 'Bearer ' . $this->backendToken()], [], [], []);
        self::assertError($noFile, 422, 'validation_failed');
        $json = $this->backend('POST', $url, ['role' => 'preview']);
        self::assertError($json, 415, 'unsupported_media_type');
        $tooLong = $this->request('POST', $url, ['role' => 'preview'], ['Authorization' => 'Bearer ' . $this->backendToken(), 'Content-Length' => (string) (2 * 1024 * 1024)], [], [], []);
        self::assertError($tooLong, 413, 'payload_too_large');
        self::assertSame([], glob($this->tmpDir() . '/var/previews/*/*') ?: []);
    }

    public function testChangeFeedPagingTombstonesAndReset(): void
    {
        $this->migrate();
        $first = self::json($this->backend('GET', '/api/v1/backend/changes?after=0&limit=3'));
        self::assertMatchesRegularExpression('/^[A-Za-z0-9_-]{8,64}$/', (string) $first['feedId']);
        self::assertCount(3, $first['items']);
        self::assertTrue($first['hasMore']);
        self::assertSame(3, $first['nextSeq']);
        self::assertSame('setting', $first['items'][0]['entity']);

        // Owner writes: create + delete a post -> upsert, then tombstone.
        $this->admin('POST', '/api/v1/admin/posts', ['publicId' => 'p_feed1', 'kind' => 'note', 'origLocale' => 'de', 'content' => ['de' => ['body' => 'Hallo']]]);
        $this->admin('DELETE', '/api/v1/admin/posts/p_feed1');
        $all = [];
        $after = 0;
        do {
            $page = self::json($this->backend('GET', '/api/v1/backend/changes?after=' . $after . '&limit=4'));
            foreach ($page['items'] as $item) {
                $all[] = $item;
            }
            self::assertGreaterThanOrEqual($after, $page['nextSeq']);
            $after = (int) $page['nextSeq'];
        } while ($page['hasMore']);
        $seqs = array_column($all, 'seq');
        $sorted = $seqs;
        sort($sorted);
        self::assertSame($sorted, $seqs, 'ascending');
        $posts = array_values(array_filter($all, static fn (array $i): bool => $i['entity'] === 'post'));
        self::assertSame(['upsert', 'delete'], array_column($posts, 'op'));
        self::assertArrayHasKey('data', $posts[0]);
        self::assertArrayNotHasKey('data', $posts[1], 'tombstones carry no data');

        // Empty page at the head: nextSeq = after.
        $head = self::json($this->backend('GET', '/api/v1/backend/changes?after=' . $after));
        self::assertSame([], $head['items']);
        self::assertSame($after, $head['nextSeq']);
        self::assertFalse($head['hasMore']);

        // Beyond the head (restored database): 409 feed_reset with the feed id.
        $reset = $this->backend('GET', '/api/v1/backend/changes?after=' . ($after + 10));
        self::assertError($reset, 409, 'feed_reset');
        self::assertSame($first['feedId'], self::json($reset)['error']['details']['feedId']);

        // Compaction keeps the latest row per key, so a full re-read still ends in the tombstone.
        $this->service(\Omw\Api\Domain\ChangeLog::class)->compact('2100-01-01T00:00:00.000Z');
        $rebuilt = self::json($this->backend('GET', '/api/v1/backend/changes?after=0&limit=1000'));
        $postOps = array_values(array_filter($rebuilt['items'], static fn (array $i): bool => $i['entity'] === 'post'));
        self::assertSame(['delete'], array_column($postOps, 'op'));
    }

    public function testChangeFeedQueryValidation(): void
    {
        self::assertError($this->backend('GET', '/api/v1/backend/changes?after=-1'), 422, 'validation_failed');
        self::assertError($this->backend('GET', '/api/v1/backend/changes?after=abc'), 422, 'validation_failed');
        self::assertError($this->backend('GET', '/api/v1/backend/changes?limit=0'), 422, 'validation_failed');
        self::assertError($this->backend('GET', '/api/v1/backend/changes?limit=5000'), 422, 'validation_failed');
        self::assertError($this->backend('GET', '/api/v1/backend/changes?since=1'), 422, 'validation_failed');
        // Regression: a malformed UTF-8 parameter name used to end in an empty 500 (JsonException
        // while rendering the error message).
        $bad = $this->backend('GET', '/api/v1/backend/changes?%FF%FE=1');
        self::assertError($bad, 422, 'validation_failed');
        self::assertStringStartsWith('Unknown query parameter(s): ', (string) self::json($bad)['error']['message']);
    }

    /** Oversized JSON bodies are never decoded (body parsing runs before routing and auth). */
    public function testOversizedJsonBodiesAreNotDecoded(): void
    {
        $big = '{"email":"owner@example.org","password":"x","pad":"' . str_repeat('a', \Omw\Api\Http\Input::MAX_JSON_BYTES) . '"}';
        self::assertNull(\Omw\Api\App::decodeJsonBody($big));
        self::assertError($this->request('POST', '/api/v1/admin/session', $big), 401, 'unauthorized');
        $hb = $this->request('POST', '/api/v1/backend/heartbeat', $big, ['Authorization' => 'Bearer ' . $this->backendToken()]);
        self::assertError($hb, 413, 'payload_too_large');
    }

    /** Regression: malformed UTF-8 in admin query strings is a 422, not a 500 from the schema validator. */
    public function testMalformedUtf8QueryParametersAreValidationErrors(): void
    {
        foreach (['/api/v1/admin/captures?%FF=1', '/api/v1/admin/captures?cursor=%FF%FE', '/api/v1/admin/posts?kind=%C3', '/api/v1/admin/posts?cursor=%80abc'] as $uri) {
            self::assertError($this->admin('GET', $uri), 422, 'validation_failed');
        }
    }

    public function testHeartbeatAndPublishedFeedTheStatus(): void
    {
        self::assertSame(204, $this->backend('POST', '/api/v1/backend/heartbeat', self::heartbeat())->getStatusCode());
        self::assertError($this->backend('POST', '/api/v1/backend/heartbeat', ['contractVersion' => 1]), 422, 'validation_failed');

        $report = ['contractVersion' => 1, 'version' => 7, 'at' => '2026-11-20T09:59:00Z', 'target' => 'sftp-main', 'ok' => true,
            'uploaded' => 12, 'deleted' => 1, 'feedSeq' => 10, 'capturesThrough' => '2026-11-20T09:00:00Z'];
        self::assertSame(204, $this->backend('POST', '/api/v1/backend/published', $report)->getStatusCode());
        $failed = ['ok' => false, 'version' => 8, 'at' => '2026-11-20T09:59:30Z', 'error' => 'connect ECONNREFUSED'] + $report;
        self::assertSame(204, $this->backend('POST', '/api/v1/backend/published', $failed)->getStatusCode());
        self::assertSame(204, $this->backend('POST', '/api/v1/backend/published', $failed)->getStatusCode(), 'replay of the same report');
        self::assertSame(204, $this->backend('POST', '/api/v1/backend/published', ['at' => '2026-11-20T09:00:00Z'] + $report)->getStatusCode(), 'older report');
        self::assertSame(204, $this->backend('POST', '/api/v1/backend/published', ['target' => 'local'] + $report)->getStatusCode());

        $status = self::json($this->admin('GET', '/api/v1/admin/status'));
        self::assertSame(self::NOW, $status['lastSeenAt']);
        self::assertSame('open', $status['backend']['wa']['state']);
        self::assertSame(['local', 'sftp-main'], array_column($status['publish'], 'target'));
        $main = $status['publish'][1];
        self::assertFalse($main['ok']);
        self::assertSame(8, $main['version']);
        self::assertSame(1, $main['consecutiveFailures'], 'replays and older reports do not count again');
        self::assertSame('2026-11-20T09:59:00.000Z', $main['lastOkAt']);
        self::assertSame([], $status['alerts']);
    }

    public function testBackupDownload(): void
    {
        self::assertError($this->backend('GET', '/api/v1/backend/backup/latest'), 404, 'not_found');
        $backup = $this->service(Backups::class)->create(Clock::now(), 'Europe/Berlin');

        $response = $this->backend('GET', '/api/v1/backend/backup/latest');
        self::assertSame(200, $response->getStatusCode());
        self::assertSame('application/vnd.sqlite3', $response->getHeaderLine('Content-Type'));
        self::assertSame($backup['sha256'], $response->getHeaderLine('X-Omw-Backup-Sha256'));
        $body = (string) $response->getBody();
        self::assertStringStartsWith("SQLite format 3\0", $body);
        self::assertSame($backup['sha256'], hash('sha256', $body));
        $etag = $response->getHeaderLine('ETag');
        $notModified = $this->request('GET', '/api/v1/backend/backup/latest', null, ['Authorization' => 'Bearer ' . $this->backendToken(), 'If-None-Match' => $etag]);
        self::assertSame(304, $notModified->getStatusCode());
        self::assertError($this->request('GET', '/api/v1/backend/backup/latest'), 401, 'unauthorized');
    }

    /** @return array<string, mixed> */
    public static function heartbeat(string $state = 'open'): array
    {
        return [
            'contractVersion' => 1,
            'at' => '2026-11-20T09:59:59Z',
            'backendVersion' => '1.0.0',
            'wa' => ['state' => $state, 'traveler' => ['pn' => null, 'lidKnown' => false]],
            'queue' => ['pending' => 0, 'failed' => 0],
            'sync' => ['feedId' => null, 'feedSeq' => 0, 'lastPullAt' => null, 'quarantined' => 0],
            'captures' => ['awaitingMedia' => 0, 'failed' => 0, 'mediaLost' => 0],
            'stats' => (object) [],
            'disk' => ['freeBytes' => 1_000_000_000],
            'publish' => (object) [],
        ];
    }

    private function upload(string $url, string $role, string $bytes, int $error = UPLOAD_ERR_OK): \Psr\Http\Message\ResponseInterface
    {
        $stream = (new StreamFactory())->createStream($bytes);
        $file = new UploadedFile($stream, 'preview.bin', 'application/octet-stream', strlen($bytes), $error);

        return $this->request('POST', $url, ['role' => $role], ['Authorization' => 'Bearer ' . $this->backendToken()], [], [], ['file' => $file]);
    }

    private static function jpeg(): string
    {
        return "\xFF\xD8\xFF\xE0\x00\x10JFIF\x00\x01\x01\x00\x00\x01\x00\x01\x00\x00" . str_repeat("\x00", 32) . "\xFF\xD9";
    }
}
