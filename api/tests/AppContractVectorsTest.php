<?php

declare(strict_types=1);

namespace Omw\Api\Tests;

use Omw\Api\Infra\SchemaValidator;

/**
 * The traveler app's wire contract from the PHP side: fixtures/vectors/app-entries.json against
 * the exported JSON Schema api/schemas/AppEntryCreate.json (packages/contracts/src/app.ts).
 *
 * - valid cases and "rules"-stage cases pass the JSON Schema (the rules stage is the cross-field
 *   check appEntryProblems(), which the API mirrors in PHP);
 * - "schema"-stage cases fail it, except the IANA zone case (a field rule JSON Schema cannot
 *   express; PHP checks zones as for every other body).
 *
 * The other app vectors (app-time, app-canonical, app-pairing, app-chunks) are for the PHP
 * implementations of the app routes; their tests belong next to that code.
 */
final class AppContractVectorsTest extends TestCase
{
    private const ZONE_NOTE = 'IANA zone rule (not expressible in JSON Schema)';

    public function testAppEntryVectorsAgreeWithTheExportedSchema(): void
    {
        $schemas = self::rootDir() . '/schemas';
        if (!is_file($schemas . '/AppEntryCreate.json')) {
            self::markTestSkipped('api/schemas/AppEntryCreate.json not generated yet (pnpm schemas).');
        }
        $validator = new SchemaValidator($schemas);
        $vectors = json_decode(
            (string) file_get_contents(dirname(self::rootDir()) . '/fixtures/vectors/app-entries.json'),
            false,
            64,
            JSON_THROW_ON_ERROR,
        );
        self::assertInstanceOf(\stdClass::class, $vectors);
        self::assertIsArray($vectors->cases);
        self::assertGreaterThan(40, count($vectors->cases));

        $checked = 0;
        foreach ($vectors->cases as $case) {
            self::assertInstanceOf(\stdClass::class, $case);
            $name = (string) $case->name;
            $errors = $validator->errors($case->body, 'AppEntryCreate');
            $stage = $case->stage ?? null;
            if ($case->valid === true || $stage === 'rules') {
                self::assertSame([], $errors, "$name: the JSON Schema must accept it");
            } elseif (($case->note ?? null) !== self::ZONE_NOTE) {
                self::assertNotSame([], $errors, "$name: the JSON Schema must reject it");
            }
            ++$checked;
        }
        self::assertSame(count($vectors->cases), $checked);
    }
}
