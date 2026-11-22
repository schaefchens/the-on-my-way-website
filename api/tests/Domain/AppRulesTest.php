<?php

declare(strict_types=1);

namespace Omw\Api\Tests\Domain;

use Omw\Api\Domain\App\AppInboxConfig;
use Omw\Api\Domain\App\AppRules;
use Omw\Api\Tests\TestCase;
use stdClass;

/**
 * The PHP port of the app rules (Domain\App\AppRules) against the vectors the TypeScript
 * contracts generate (fixtures/vectors/app-*.json, packages/contracts/scripts/app-vectors.ts).
 */
final class AppRulesTest extends TestCase
{
    public function testEntryRulesMatchTheSharedVectors(): void
    {
        $vectors = self::vectors('app-entries');
        $checked = 0;
        foreach ($vectors->cases as $case) {
            $name = (string) $case->name;
            $stage = $case->stage ?? null;
            if ($case->valid !== true && $stage !== 'rules') {
                continue; // schema-stage cases: AppContractVectorsTest
            }
            $paths = array_map(
                static fn (array $p): string => implode('.', $p['path']),
                AppRules::entryProblems($case->body->entry),
            );
            $expected = $case->valid === true ? [] : array_map('strval', $case->paths);
            sort($paths);
            sort($expected);
            self::assertSame(array_values(array_unique($expected)), array_values(array_unique($paths)), $name);
            ++$checked;
        }
        self::assertGreaterThan(20, $checked);
    }

    public function testTimeCorrectionMatchesTheSharedVectors(): void
    {
        foreach (self::vectors('app-time')->cases as $case) {
            $in = $case->input;
            $got = AppRules::correctOccurredAt((string) $in->occurredAt, (string) $in->clientNow, (string) $in->serverNow);
            self::assertSame(
                ['occurredAt' => $case->expected->occurredAt, 'clamped' => $case->expected->clamped, 'heldBack' => $case->expected->heldBack],
                $got,
                (string) $case->name,
            );
        }
    }

    public function testCanonicalJsonAndEntryHashMatchTheSharedVectors(): void
    {
        foreach (self::vectors('app-canonical')->cases as $case) {
            $sha = (string) $case->sha256Hex;
            self::assertSame($case->canonical, AppRules::canonicalJson($case->value), (string) $case->name);
            self::assertSame($sha, hash('sha256', AppRules::canonicalJson($case->value)), (string) $case->name);
            $value = $case->value;
            if ($value instanceof stdClass && isset($value->entryId)) {
                self::assertSame($sha, AppRules::entryHash($value));
            }
        }
    }

    public function testPairingCodesMatchTheSharedVectors(): void
    {
        $vectors = self::vectors('app-pairing');
        foreach ($vectors->normalize as $case) {
            self::assertSame($case->expected, AppRules::normalizePairingCode((string) $case->input), (string) $case->input);
        }
        foreach ($vectors->format as $case) {
            self::assertSame($case->expected, AppRules::formatTypedCode((string) $case->code));
        }
        $code = AppRules::randomCode(AppRules::TYPED_CODE_CHARS);
        self::assertSame($code, AppRules::normalizePairingCode(AppRules::formatTypedCode($code)));
        self::assertSame(26, strlen(AppRules::randomCode(AppRules::LINK_CODE_CHARS)));
    }

    public function testUploadChecksumHeaderMatchesTheSharedVectors(): void
    {
        $vectors = self::vectors('app-chunks');
        foreach ($vectors->checksum as $case) {
            self::assertSame($case->hex, AppRules::parseUploadChecksum((string) $case->header), (string) $case->name);
            self::assertSame($case->header, AppRules::formatUploadChecksum((string) $case->hex));
        }
        foreach ($vectors->badHeaders as $header) {
            self::assertNull(AppRules::parseUploadChecksum((string) $header), (string) $header);
        }
    }

    public function testInboxConfigReadsItsOwnKeysAndAnnouncesSafeChunks(): void
    {
        $config = AppInboxConfig::fromArray(['APP_INBOX_MAX_BYTES' => (string) (200 * AppRules::MIB), 'APP_TRANSFER_SLOTS' => '2']);
        self::assertSame(200 * AppRules::MIB, $config->maxBytes);
        self::assertSame(2, $config->transferSlots);
        self::assertSame(100 * AppRules::MIB, $config->fileMaxBytes('original'));
        self::assertSame(AppRules::PREVIEW_MAX_BYTES, $config->fileMaxBytes('preview'));
        self::assertSame(0, $config->chunkMaxBytes() % (64 * 1024));
        self::assertLessThanOrEqual(AppRules::CHUNK_MAX_BYTES, $config->chunkMaxBytes());
        self::assertGreaterThanOrEqual(AppRules::CHUNK_MIN_BYTES, $config->chunkMaxBytes());

        $this->expectException(\InvalidArgumentException::class);
        AppInboxConfig::fromArray(['APP_TRANSFER_SLOTS' => '0']);
    }

    private static function vectors(string $name): stdClass
    {
        $data = json_decode((string) file_get_contents(dirname(self::rootDir()) . "/fixtures/vectors/$name.json"), false, 64, JSON_THROW_ON_ERROR);
        self::assertInstanceOf(stdClass::class, $data);

        return $data;
    }
}
