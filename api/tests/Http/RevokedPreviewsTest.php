<?php

declare(strict_types=1);

namespace Omw\Api\Tests\Http;

use Omw\Api\Infra\CronRunner;
use Omw\Api\Infra\Db;
use Psr\Http\Message\ResponseInterface;
use Slim\Psr7\Factory\StreamFactory;
use Slim\Psr7\UploadedFile;

/**
 * Private previews of statuses deleted on WhatsApp (review L1-04, W2-9): with ingest.on_revoke =
 * hide (default) a revoke deletes them, later uploads are discarded and the cron sweep removes
 * the ones of rows revoked earlier; with "keep" they stay.
 */
final class RevokedPreviewsTest extends ApiTestCase
{
    private const WEBP = "RIFF\x24\x00\x00\x00WEBPVP8 \x18\x00\x00\x00\x30\x01\x00\x9d\x01\x2a\x01\x00\x01\x00\x02\x00\x34\x25\xa4\x00\x03\x70\x00\xfe\xfb\x94\x00\x00";

    public function testRevokeDeletesPreviewAndPoster(): void
    {
        $sourceKey = $this->captureWithPreviews('3EB0REV1');
        $item = $this->item($sourceKey);
        self::assertIsString($item['previewUrl']);
        self::assertIsString($item['posterUrl']);
        self::assertCount(2, $this->previewFiles());

        self::assertSame(204, $this->revoke($sourceKey)->getStatusCode());

        self::assertSame([], $this->previewFiles());
        $after = $this->item($sourceKey);
        self::assertNull($after['previewUrl']);
        self::assertNull($after['posterUrl']);
        self::assertSame('hidden', $after['effectiveVisibility']);
        self::assertError($this->admin('GET', (string) $item['previewUrl']), 404, 'not_found');
        self::assertError($this->admin('GET', (string) $item['posterUrl']), 404, 'not_found');
        $listed = self::json($this->admin('GET', '/api/v1/admin/captures'))['items'];
        self::assertNull($listed[0]['previewUrl']);

        // Idempotent: a second revoke (and already missing files) is fine.
        self::assertSame(204, $this->revoke($sourceKey)->getStatusCode());

        // The backend's queue may still push a preview: accepted, but nothing is stored.
        self::assertSame(204, $this->upload($sourceKey, 'preview')->getStatusCode());
        self::assertSame([], $this->previewFiles());
        self::assertNull($this->item($sourceKey)['previewUrl']);
    }

    public function testARevokeThroughTheMirrorDeletesThemToo(): void
    {
        $sourceKey = $this->captureWithPreviews('3EB0REV2');
        $this->putCapture('3EB0REV2', '2026-11-18T02:00:00Z', ['kind' => 'video', 'revokedAt' => '2026-11-19T00:00:00Z']);
        self::assertSame([], $this->previewFiles());
        self::assertNull($this->item($sourceKey)['previewUrl']);
    }

    public function testAMissingFileDoesNotBreakTheRevoke(): void
    {
        $sourceKey = $this->captureWithPreviews('3EB0REV3');
        foreach ($this->previewFiles() as $file) {
            unlink($file);
        }
        self::assertSame(204, $this->revoke($sourceKey)->getStatusCode());
        self::assertNull($this->service(Db::class)->scalar('SELECT preview_path FROM captures'));
    }

    public function testKeepModeRetainsThePreviews(): void
    {
        $this->admin('PATCH', '/api/v1/admin/settings', ['ingest.on_revoke' => 'keep']);
        $sourceKey = $this->captureWithPreviews('3EB0REV4');
        self::assertSame(204, $this->revoke($sourceKey)->getStatusCode());

        self::assertCount(2, $this->previewFiles());
        $item = $this->item($sourceKey);
        self::assertIsString($item['previewUrl']);
        self::assertSame('public', $item['effectiveVisibility']);
        self::assertSame(200, $this->admin('GET', (string) $item['previewUrl'])->getStatusCode());
        self::assertSame(204, $this->upload($sourceKey, 'preview', self::WEBP . 'v2')->getStatusCode());
        self::assertCount(2, $this->previewFiles(), 'replaced, still kept');

        $this->cron();
        self::assertCount(2, $this->previewFiles(), 'the sweep leaves "keep" alone');
    }

    public function testTheCronSweepRemovesPreviewsOfEarlierRevokes(): void
    {
        // Revoked while "keep" was set (like rows revoked before this rule existed) ...
        $this->admin('PATCH', '/api/v1/admin/settings', ['ingest.on_revoke' => 'keep']);
        $revoked = $this->captureWithPreviews('3EB0REV5');
        $live = $this->captureWithPreviews('3EB0REV6');
        $this->revoke($revoked);
        self::assertCount(4, $this->previewFiles());

        // ... then back to "hide": the next cron run removes them, the live capture keeps its own.
        $this->admin('PATCH', '/api/v1/admin/settings', ['ingest.on_revoke' => 'hide']);
        $result = $this->cron();
        self::assertSame(2, $result['jobs']['cleanup']['revokedPreviewsRemoved'] ?? null);
        self::assertCount(2, $this->previewFiles());
        self::assertNull($this->item($revoked)['previewUrl']);
        self::assertIsString($this->item($live)['previewUrl']);

        self::assertSame(0, $this->cron()['jobs']['cleanup']['revokedPreviewsRemoved'] ?? null, 'idempotent');
    }

    private function captureWithPreviews(string $msgId): string
    {
        $sourceKey = $this->putCapture($msgId, '2026-11-18T02:00:00Z', ['kind' => 'video', 'media' => ['w' => 720, 'h' => 1280, 'duration' => 12.5]]);
        self::assertSame(204, $this->upload($sourceKey, 'preview')->getStatusCode());
        self::assertSame(204, $this->upload($sourceKey, 'poster', self::WEBP . $msgId)->getStatusCode());

        return $sourceKey;
    }

    /** @return array<string, mixed> */
    private function item(string $sourceKey): array
    {
        return self::json($this->admin('GET', '/api/v1/admin/captures/' . rawurlencode($sourceKey)));
    }

    private function revoke(string $sourceKey): ResponseInterface
    {
        return $this->backend('POST', '/api/v1/backend/captures/' . rawurlencode($sourceKey) . '/revoke', ['contractVersion' => 1, 'at' => '2026-11-19T00:00:00Z']);
    }

    private function upload(string $sourceKey, string $role, string $bytes = self::WEBP): ResponseInterface
    {
        $file = new UploadedFile((new StreamFactory())->createStream($bytes), 'preview.bin', 'application/octet-stream', strlen($bytes), UPLOAD_ERR_OK);

        return $this->request('POST', '/api/v1/backend/captures/' . rawurlencode($sourceKey) . '/preview', ['role' => $role], ['Authorization' => 'Bearer ' . $this->backendToken()], [], [], ['file' => $file]);
    }

    /** @return list<string> */
    private function previewFiles(): array
    {
        return glob($this->tmpDir() . '/var/previews/*/*') ?: [];
    }

    /** @return array<string, mixed> */
    private function cron(): array
    {
        return $this->service(CronRunner::class)->run(null, ['cleanup']);
    }
}
