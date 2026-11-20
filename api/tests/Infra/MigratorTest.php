<?php

declare(strict_types=1);

namespace Omw\Api\Tests\Infra;

use Omw\Api\Infra\Db;
use Omw\Api\Infra\Migrator;
use Omw\Api\Tests\TestCase;
use PDOException;
use RuntimeException;

final class MigratorTest extends TestCase
{
    private const TABLES = [
        'alerts', 'annotations', 'api_tokens', 'backend_status', 'captures', 'change_log', 'days',
        'login_attempts', 'meta', 'posts', 'publish_status', 'schema_migrations', 'settings', 'trips', 'users',
    ];

    public function testAppliesAllMigrationsToAFreshDatabase(): void
    {
        $config = $this->config();
        $db = $this->db($config);
        $migrator = new Migrator($db, $config->migrationsDir());

        self::assertContains('0001_init', $migrator->pending());
        $applied = $migrator->migrate();

        self::assertSame(array_keys($migrator->available()), $applied);
        self::assertSame([], $migrator->pending());
        self::assertFileExists($config->dbPath);

        $tables = array_map(
            static fn (array $r): string => (string) $r['name'],
            $db->all("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"),
        );
        foreach (self::TABLES as $table) {
            self::assertContains($table, $tables, "table $table");
        }
    }

    public function testConnectionPragmas(): void
    {
        $db = $this->migratedDb($this->config());

        self::assertSame('wal', $db->effectiveJournalMode());
        self::assertSame('wal', $db->scalar('PRAGMA journal_mode'));
        self::assertSame(1, $db->scalar('PRAGMA foreign_keys'));
        self::assertSame(Db::BUSY_TIMEOUT_MS, $db->scalar('PRAGMA busy_timeout'));
    }

    public function testDeleteJournalModeCanBeConfigured(): void
    {
        $db = $this->migratedDb($this->config(['DB_JOURNAL_MODE' => 'DELETE']));

        self::assertSame('delete', $db->effectiveJournalMode());
    }

    public function testSwitchesAnExistingDatabaseFromWalToDelete(): void
    {
        $this->migratedDb($this->config())->close();
        $db = $this->db($this->config(['DB_JOURNAL_MODE' => 'DELETE']));

        self::assertSame('delete', $db->effectiveJournalMode());
    }

    public function testIsIdempotent(): void
    {
        $config = $this->config();
        $db = $this->migratedDb($config);
        $migrator = new Migrator($db, $config->migrationsDir());

        self::assertSame([], $migrator->migrate());
        self::assertSame([], $migrator->modified());
        self::assertCount(count($migrator->available()), $migrator->applied());
    }

    public function testSeedsDefaultSettingsAndAnnouncesThemOnTheChangeFeed(): void
    {
        $db = $this->migratedDb($this->config());

        $settings = [];
        foreach ($db->all('SELECT key, value FROM settings') as $row) {
            $settings[(string) $row['key']] = json_decode((string) $row['value'], true, 8, JSON_THROW_ON_ERROR);
        }
        self::assertSame('instant', $settings['publish.mode']);
        self::assertSame(720, $settings['publish.delay_minutes']);
        self::assertSame('hide', $settings['ingest.on_revoke']);
        self::assertSame(['de', 'en'], $settings['site.locales']);
        self::assertSame('de', $settings['site.default_locale']);
        self::assertFalse($settings['site.indexable']);
        self::assertSame(15, $settings['alerts.heartbeat_stale_minutes']);
        self::assertSame('1970-01-01T00:00:00.000Z', $settings['publish.mode_since']);
        self::assertMatchesRegularExpression('/^[0-9a-f]{32}$/', (string) $db->scalar("SELECT value FROM meta WHERE key = 'feed_id'"));
        self::assertArrayHasKey('timezone.current', $settings);
        self::assertArrayHasKey('site.title', $settings);

        $changes = $db->all('SELECT seq, entity, entity_key, op, data, created_at FROM change_log ORDER BY seq');
        self::assertCount(count($settings), $changes);
        $prev = 0;
        foreach ($changes as $change) {
            self::assertGreaterThan($prev, $change['seq']);
            $prev = (int) $change['seq'];
            self::assertSame('setting', $change['entity']);
            self::assertSame('upsert', $change['op']);
            $data = json_decode((string) $change['data'], true, 8, JSON_THROW_ON_ERROR);
            self::assertSame(['value' => $settings[(string) $change['entity_key']]], $data, 'ChangeItem.data of a setting is {value}');
            self::assertMatchesRegularExpression('/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/', (string) $change['created_at']);
        }
    }

    public function testConstraintsGuardTheData(): void
    {
        $db = $this->migratedDb($this->config());
        $now = '2026-11-19T12:00:00.000Z';

        $rejected = [
            'annotation visibility' => ["INSERT INTO annotations (source_key, visibility, created_at, updated_at) VALUES ('wa:X', 'secret', ?, ?)", [$now, $now]],
            'invalid JSON' => ["INSERT INTO settings (key, value, updated_at) VALUES ('x', '{nope', ?)", [$now]],
            'post id prefix' => ["INSERT INTO posts (public_id, kind, occurred_at, tz, local_date, content, orig_locale, created_at, updated_at) VALUES ('x_1', 'note', ?, 'UTC', '2026-11-19', '{}', 'de', ?, ?)", [$now, $now, $now]],
            'backend token with admin scope' => ["INSERT INTO api_tokens (kind, token_hash, token_hint, scopes, created_at) VALUES ('backend', ?, 'x', '[\"admin\"]', ?)", [str_repeat('b', 64), $now]],
            'media state' => ["INSERT INTO captures (source_key, public_id, kind, occurred_at, tz, local_date, media_state, mirrored_at, updated_at) VALUES ('wa:X', 'e_aaaaaaaaaaaa', 'photo', ?, 'UTC', '2026-11-19', 'downloading', ?, ?)", [$now, $now, $now]],
            'country code' => ["INSERT INTO days (local_date, country_code, created_at, updated_at) VALUES ('2026-11-19', 'vn', ?, ?)", [$now, $now]],
            'trip dates' => ["INSERT INTO trips (slug, title, start_date, end_date, created_at, updated_at) VALUES ('t', '{}', '2026-11-19', '2026-11-18', ?, ?)", [$now, $now]],
            'upsert without data' => ["INSERT INTO change_log (entity, entity_key, op, created_at) VALUES ('post', 'p_1', 'upsert', ?)", [$now]],
            'session token without user' => ["INSERT INTO api_tokens (kind, token_hash, token_hint, scopes, created_at) VALUES ('session', ?, 'x', '[\"admin\"]', ?)", [str_repeat('a', 64), $now]],
            'second open alert of a kind' => ["INSERT INTO alerts (kind, message, opened_at) VALUES ('heartbeat_stale', 'a', ?), ('heartbeat_stale', 'b', ?)", [$now, $now]],
        ];
        foreach ($rejected as $label => [$sql, $params]) {
            try {
                $db->exec($sql, $params);
                self::fail("Expected the database to reject: $label");
            } catch (PDOException $e) {
                self::assertStringContainsString('constraint', strtolower($e->getMessage()), $label);
            }
        }

        $db->exec("INSERT INTO trips (slug, title, start_date, end_date, created_at, updated_at) VALUES ('vietnam-2026', '{\"de\":\"Vietnam\"}', '2026-11-01', '2026-11-30', ?, ?)", [$now, $now]);
        $db->exec("INSERT INTO days (local_date, tz, country_code, created_at, updated_at) VALUES ('2026-11-19', 'Asia/Ho_Chi_Minh', 'VN', ?, ?)", [$now, $now]);
        self::assertSame('Asia/Ho_Chi_Minh', $db->scalar("SELECT tz FROM days WHERE local_date = '2026-11-19'"));
    }

    public function testDetectsAppliedMigrationsThatChangedOnDisk(): void
    {
        $dir = $this->copyMigrations();
        $db = $this->db($this->config());
        (new Migrator($db, $dir))->migrate();

        file_put_contents($dir . '/0001_init.sql', "\n-- edited\n", FILE_APPEND);

        self::assertSame(['0001_init'], (new Migrator($db, $dir))->modified());
    }

    public function testAFailingMigrationIsRolledBackAndNotRecorded(): void
    {
        $dir = $this->copyMigrations();
        file_put_contents($dir . '/9999_broken.sql', "CREATE TABLE half_done (id INTEGER);\nTHIS IS NOT SQL;\n");
        $db = $this->db($this->config());
        $migrator = new Migrator($db, $dir);

        try {
            $migrator->migrate();
            self::fail('Expected the broken migration to throw.');
        } catch (PDOException) {
        }

        self::assertSame(['9999_broken'], $migrator->pending());
        self::assertNull($db->scalar("SELECT name FROM sqlite_master WHERE name = 'half_done'"));
        self::assertNotNull($db->scalar("SELECT name FROM sqlite_master WHERE name = 'captures'"), 'earlier migrations stay applied');
    }

    public function testForeignKeysOffDirectiveAllowsTableRebuilds(): void
    {
        $dir = $this->copyMigrations();
        $db = $this->db($this->config());
        (new Migrator($db, $dir))->migrate();
        $now = '2026-11-19T12:00:00.000Z';
        $db->exec("INSERT INTO users (email, password_hash, created_at, updated_at) VALUES ('o@example.org', 'x', ?, ?)", [$now, $now]);
        $userId = (int) $db->scalar('SELECT id FROM users');
        $db->exec("INSERT INTO api_tokens (kind, user_id, token_hash, token_hint, scopes, created_at) VALUES ('app', ?, ?, 'x', '[\"admin\"]', ?)", [$userId, str_repeat('c', 64), $now]);

        // 12-step rebuild of users (referenced by api_tokens ON DELETE CASCADE): adds a column.
        $rebuild = static fn (string $tmp): string => <<<SQL
            CREATE TABLE $tmp (
                id            INTEGER PRIMARY KEY,
                email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
                password_hash TEXT NOT NULL,
                display_name  TEXT,
                role          TEXT NOT NULL DEFAULT 'owner' CHECK (role IN ('owner')),
                created_at    TEXT NOT NULL,
                updated_at    TEXT NOT NULL,
                last_login_at TEXT,
                locale        TEXT
            );
            INSERT INTO $tmp (id, email, password_hash, display_name, role, created_at, updated_at, last_login_at)
                SELECT id, email, password_hash, display_name, role, created_at, updated_at, last_login_at FROM users;
            DROP TABLE users;
            ALTER TABLE $tmp RENAME TO users;

            SQL;
        file_put_contents($dir . '/9001_rebuild_users.sql', Migrator::FOREIGN_KEYS_OFF . "\n" . $rebuild('users_new'));
        self::assertTrue(Migrator::wantsForeignKeysOff((string) file_get_contents($dir . '/9001_rebuild_users.sql')));
        self::assertSame(['9001_rebuild_users'], (new Migrator($db, $dir))->migrate());

        self::assertSame(1, (int) $db->scalar('SELECT COUNT(*) FROM api_tokens'), 'tokens survived the rebuild');
        self::assertSame(1, $db->scalar('PRAGMA foreign_keys'), 'foreign keys are back on');
        self::assertSame([], $db->all('PRAGMA foreign_key_check'));

        // Without the directive the same rebuild cascade-deletes every token (DROP TABLE = DELETE).
        file_put_contents($dir . '/9002_rebuild_again.sql', $rebuild('users_tmp'));
        self::assertFalse(Migrator::wantsForeignKeysOff((string) file_get_contents($dir . '/9002_rebuild_again.sql')));
        (new Migrator($db, $dir))->migrate();
        self::assertSame(0, (int) $db->scalar('SELECT COUNT(*) FROM api_tokens'));
    }

    public function testRejectsBadlyNamedMigrationFiles(): void
    {
        $dir = $this->copyMigrations();
        file_put_contents($dir . '/2-oops.sql', 'SELECT 1;');

        $this->expectException(RuntimeException::class);
        (new Migrator($this->db($this->config()), $dir))->available();
    }

    private function copyMigrations(): string
    {
        $dir = $this->tmpDir() . '/migrations';
        mkdir($dir);
        foreach (glob(self::rootDir() . '/migrations/*.sql') ?: [] as $file) {
            copy($file, $dir . '/' . basename($file));
        }

        return $dir;
    }
}
