<?php

declare(strict_types=1);

namespace Omw\Api\Tests\Http;

use DI\Container;
use Omw\Api\Domain\App\AppInboxConfig;
use Omw\Api\Domain\App\AppRules;
use Psr\Http\Message\ResponseInterface;

/**
 * Helpers for the traveler-app tests (a connected phone, entries with real bytes, tus chunks).
 * Used by ApiTestCase subclasses.
 */
trait AppTestHelpers
{
    /** @var array<string, string> role => bytes of the last entry made by photoEntry() */
    protected array $files = [];

    /** Boots the app with its own inbox settings (before the first request). */
    protected function useInbox(AppInboxConfig $config): void
    {
        $container = $this->container();
        self::assertInstanceOf(Container::class, $container);
        $container->set(AppInboxConfig::class, $config);
    }

    /** Connects a phone through the admin's pairing code; returns its capture token. */
    protected function pairPhone(string $name = 'Pixel 8a'): string
    {
        $created = $this->admin('POST', '/api/v1/admin/app-pairings', ['ttlMinutes' => 60]);
        self::assertSame(201, $created->getStatusCode(), (string) $created->getBody());
        $typed = (string) self::json($created)['typedCode'];
        $paired = $this->request('POST', '/api/v1/app/pair', self::pairBody(str_replace('-', '', $typed), $name));
        self::assertSame(201, $paired->getStatusCode(), (string) $paired->getBody());

        return (string) self::json($paired)['token'];
    }

    /** @return array<string, mixed> */
    protected static function pairBody(string $code, string $name = 'Pixel 8a'): array
    {
        return ['contractVersion' => 1, 'code' => $code, 'deviceName' => $name, 'platform' => 'android', 'appVersion' => '2026.11.20-test'];
    }

    /**
     * @param array<string, mixed>|object|string|null $body
     * @param array<string, string>                   $headers
     */
    protected function phone(string $token, string $method, string $uri, array|object|string|null $body = null, array $headers = []): ResponseInterface
    {
        return $this->request($method, $uri, $body, ['Authorization' => 'Bearer ' . $token] + $headers);
    }

    /**
     * An AppEntryCreate for a photo with real bytes (kept in $this->files by role).
     *
     * @param list<string>         $roles
     * @param array<string, mixed> $entryExtra
     * @return array<string, mixed>
     */
    protected function photoEntry(string $entryId, array $roles = ['media', 'preview', 'original'], array $entryExtra = [], string $clientNow = ApiTestCase::NOW): array
    {
        $sizes = ['media' => 300 * 1024 + 17, 'preview' => 20 * 1024, 'original' => 700 * 1024 + 5];
        $types = ['media' => 'image/jpeg', 'preview' => 'image/jpeg', 'original' => 'image/heic'];
        $files = [];
        $this->files = [];
        foreach ($roles as $role) {
            $bytes = random_bytes($sizes[$role]);
            $this->files[$role] = $bytes;
            $files[] = ['role' => $role, 'mimetype' => $types[$role], 'bytes' => strlen($bytes), 'sha256Hex' => hash('sha256', $bytes)];
        }

        return [
            'contractVersion' => 1,
            'clientNow' => $clientNow,
            'entry' => array_merge([
                'schema' => 1,
                'entryId' => $entryId,
                'source' => 'app',
                'kind' => 'photo',
                'occurredAt' => '2026-11-20T09:59:00.000Z',
                'tz' => 'Asia/Ho_Chi_Minh',
                'caption' => 'Lanterns in Hội An',
                'media' => ['width' => 1600, 'height' => 1200],
                'files' => $files,
                'client' => ['app' => '2026.11.20-test', 'platform' => 'android', 'os' => '16'],
            ], $entryExtra),
        ];
    }

    /** @return array<string, mixed> */
    protected static function textEntry(string $entryId): array
    {
        return [
            'contractVersion' => 1,
            'clientNow' => ApiTestCase::NOW,
            'entry' => [
                'schema' => 1,
                'entryId' => $entryId,
                'source' => 'app',
                'kind' => 'text',
                'occurredAt' => '2026-11-20T09:59:30.000Z',
                'tz' => 'Asia/Ho_Chi_Minh',
                'text' => ['body' => 'Arrived in Hội An!', 'bgArgb' => 0xff7e57c2, 'textArgb' => 0xffffffff, 'font' => 'SYSTEM'],
                'files' => [],
                'client' => ['app' => '2026.11.20-test', 'platform' => 'android'],
            ],
        ];
    }

    /** @param array<string, string> $extra */
    protected function patchChunk(string $token, string $uploadId, int $offset, string $chunk, array $extra = []): ResponseInterface
    {
        return $this->phone($token, 'PATCH', '/api/v1/app/uploads/' . $uploadId, $chunk, $extra + [
            'Tus-Resumable' => '1.0.0',
            'Content-Type' => 'application/offset+octet-stream',
            'Content-Length' => (string) strlen($chunk),
            'Upload-Offset' => (string) $offset,
            'Upload-Checksum' => AppRules::formatUploadChecksum(hash('sha256', $chunk)),
        ]);
    }

    /** Uploads one whole file in chunks of $chunkBytes. */
    protected function uploadAll(string $token, string $uploadId, string $bytes, int $chunkBytes = 256 * 1024): void
    {
        for ($offset = 0; $offset < strlen($bytes); $offset += $chunkBytes) {
            $response = $this->patchChunk($token, $uploadId, $offset, substr($bytes, $offset, $chunkBytes));
            self::assertSame(204, $response->getStatusCode(), (string) $response->getBody());
            self::assertSame((string) min(strlen($bytes), $offset + $chunkBytes), $response->getHeaderLine('Upload-Offset'));
        }
    }

    /**
     * @param array<string, mixed> $state AppEntryState
     * @return array<string, string> role => uploadId
     */
    protected static function slots(array $state): array
    {
        $out = [];
        self::assertIsArray($state['uploads']);
        foreach ($state['uploads'] as $slot) {
            self::assertIsArray($slot);
            $out[(string) $slot['role']] = (string) $slot['uploadId'];
        }

        return $out;
    }
}
