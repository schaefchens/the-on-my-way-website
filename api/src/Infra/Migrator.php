<?php

declare(strict_types=1);

namespace Omw\Api\Infra;

use PDO;
use RuntimeException;

/**
 * Applies migrations/NNNN_name.sql files in lexical order, each in its own BEGIN IMMEDIATE
 * transaction, and records them in schema_migrations (version = file name without ".sql",
 * checksum = sha256 of the file). Applied migrations are never re-run; editing an applied
 * file is reported by {@see modified()} (and by bin/doctor.php) instead.
 *
 * Migration files must not contain BEGIN/COMMIT or PRAGMAs that cannot run inside a transaction.
 *
 * Table rebuilds (SQLite's 12-step ALTER) of FK-linked tables need foreign keys OFF, which is a
 * no-op inside a transaction. A file whose first line is "-- omw:foreign-keys=off" therefore runs
 * with PRAGMA foreign_keys=OFF set BEFORE its BEGIN IMMEDIATE; PRAGMA foreign_key_check still runs
 * before COMMIT (violations abort the migration), and foreign keys are switched back ON afterwards.
 */
final class Migrator
{
    private const FILE_PATTERN = '/^(\d{4}_[a-z0-9_]+)\.sql$/';

    /** First-line directive of migrations that rebuild FK-linked tables. */
    public const FOREIGN_KEYS_OFF = '-- omw:foreign-keys=off';

    public function __construct(
        private readonly Db $db,
        private readonly string $dir,
    ) {
    }

    /** Directory of the migration files. */
    public function directory(): string
    {
        return $this->dir;
    }

    /**
     * All migration files on disk, keyed by version, in apply order.
     *
     * @return array<string, string> version => absolute path
     */
    public function available(): array
    {
        $files = glob($this->dir . '/*.sql') ?: [];
        $out = [];
        foreach ($files as $file) {
            $name = basename($file);
            if (preg_match(self::FILE_PATTERN, $name, $m) !== 1) {
                throw new RuntimeException(sprintf('Invalid migration file name "%s" (expected NNNN_snake_case.sql).', $name));
            }
            $out[$m[1]] = $file;
        }
        ksort($out, SORT_STRING);

        return $out;
    }

    /**
     * @return array<string, array{checksum: string, applied_at: string}>
     */
    public function applied(): array
    {
        $this->ensureTable();
        $out = [];
        foreach ($this->db->all('SELECT version, checksum, applied_at FROM schema_migrations ORDER BY version') as $row) {
            $out[(string) $row['version']] = [
                'checksum' => (string) $row['checksum'],
                'applied_at' => (string) $row['applied_at'],
            ];
        }

        return $out;
    }

    /** @return list<string> versions not yet applied, in apply order */
    public function pending(): array
    {
        return array_values(array_diff(array_keys($this->available()), array_keys($this->applied())));
    }

    /** @return list<string> applied versions whose file content changed since they were applied */
    public function modified(): array
    {
        $available = $this->available();
        $out = [];
        foreach ($this->applied() as $version => $info) {
            if (isset($available[$version]) && self::checksum($available[$version]) !== $info['checksum']) {
                $out[] = $version;
            }
        }

        return $out;
    }

    /**
     * Applies all pending migrations.
     *
     * @param (callable(string): void)|null $onApplied called with each version after it committed
     * @return list<string> versions applied by this call
     */
    public function migrate(?callable $onApplied = null): array
    {
        $this->ensureTable();
        $done = [];
        foreach ($this->available() as $version => $file) {
            $sql = file_get_contents($file);
            if ($sql === false) {
                throw new RuntimeException('Cannot read ' . $file);
            }
            $checksum = hash('sha256', $sql);
            $fkOff = self::wantsForeignKeysOff($sql);
            if ($fkOff) {
                $this->db->pdo()->exec('PRAGMA foreign_keys = OFF');
            }

            try {
                $applied = $this->db->write(function (PDO $pdo) use ($version, $sql, $checksum): bool {
                    // Re-check inside the write lock: another process may have applied it meanwhile.
                    $stmt = $pdo->prepare('SELECT 1 FROM schema_migrations WHERE version = ?');
                    $stmt->execute([$version]);
                    if ($stmt->fetchColumn() !== false) {
                        return false;
                    }

                    $pdo->exec($sql);

                    $check = $pdo->query('PRAGMA foreign_key_check');
                    $violations = $check === false ? [] : $check->fetchAll();
                    if ($violations !== []) {
                        throw new RuntimeException(sprintf('Migration %s leaves %d foreign key violation(s).', $version, count($violations)));
                    }

                    $insert = $pdo->prepare('INSERT INTO schema_migrations (version, checksum, applied_at) VALUES (?, ?, ?)');
                    $insert->execute([$version, $checksum, Clock::nowIso()]);

                    return true;
                });
            } finally {
                if ($fkOff) {
                    $this->db->pdo()->exec('PRAGMA foreign_keys = ON');
                }
            }

            if ($applied) {
                $done[] = $version;
                if ($onApplied !== null) {
                    $onApplied($version);
                }
            }
        }

        return $done;
    }

    private function ensureTable(): void
    {
        $this->db->pdo()->exec(<<<'SQL'
            CREATE TABLE IF NOT EXISTS schema_migrations (
                version    TEXT PRIMARY KEY,
                checksum   TEXT NOT NULL,
                applied_at TEXT NOT NULL
            )
            SQL);
    }

    public static function wantsForeignKeysOff(string $sql): bool
    {
        $firstLine = strtok(ltrim($sql), "\n");

        return $firstLine !== false && rtrim($firstLine) === self::FOREIGN_KEYS_OFF;
    }

    private static function checksum(string $file): string
    {
        return (string) hash_file('sha256', $file);
    }
}
