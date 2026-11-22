<?php

declare(strict_types=1);

namespace Omw\Api\Tests\Infra;

use Omw\Api\Infra\Migrator;
use Omw\Api\Tests\TestCase;

/**
 * migrations/0050_app_inbox.sql: purely additive and safe to apply again. The app branch's dev
 * databases ran it as 0004_app_inbox before it was renumbered; there it must apply as a no-op
 * (same schema, nothing lost) instead of failing on "table already exists".
 */
final class AppMigrationTest extends TestCase
{
    private const APP_TABLES = ['app_entries', 'app_pairings', 'app_phones', 'app_rate_hits', 'app_state', 'app_uploads'];

    public function testTheAppInboxTablesExistAfterAFreshMigration(): void
    {
        $config = $this->config();
        $db = $this->db($config);
        (new Migrator($db, $config->migrationsDir()))->migrate();

        $tables = array_map(
            static fn (array $r): string => (string) $r['name'],
            $db->all("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'app_%' ORDER BY name"),
        );
        self::assertSame(self::APP_TABLES, $tables);
    }

    public function testADatabaseThatRanTheFileUnderItsOldNumberMigratesCleanly(): void
    {
        $config = $this->config();
        $db = $this->db($config);
        $migrator = new Migrator($db, $config->migrationsDir());
        $migrator->migrate();
        $db->exec("INSERT INTO app_state (key, value, updated_at) VALUES ('kept', '1', '2026-11-20T10:00:00.000Z')");
        // As on a dev database of the app branch: applied as 0004_app_inbox, 0050 not recorded yet.
        $db->exec("UPDATE schema_migrations SET version = '0004_app_inbox' WHERE version = '0050_app_inbox'");

        self::assertSame(['0050_app_inbox'], $migrator->pending());
        self::assertSame(['0050_app_inbox'], $migrator->migrate());
        self::assertSame([], $migrator->pending());
        self::assertSame('1', $db->scalar("SELECT value FROM app_state WHERE key = 'kept'"));
    }
}
