<?php

declare(strict_types=1);

namespace Omw\Api\Infra;

use Omw\Api\Config;
use PDO;
use PDOException;
use Psr\Log\LoggerInterface;
use Throwable;

/**
 * Lazily connected SQLite (PDO) handle.
 *
 * Every connection gets busy_timeout=5000 and foreign_keys=ON; the journal mode comes from
 * DB_JOURNAL_MODE (WAL by default; DELETE for NFS-backed hosting where WAL does not work).
 * Writes go through {@see write()}, which uses BEGIN IMMEDIATE so concurrent writers wait for
 * the lock up front instead of failing with SQLITE_BUSY halfway through a transaction.
 */
final class Db
{
    public const BUSY_TIMEOUT_MS = 5000;

    private ?PDO $pdo = null;
    private int $depth = 0;
    private string $effectiveJournalMode = '';

    /**
     * @param string $path        SQLite file path, or ":memory:"
     * @param string $journalMode WAL|DELETE
     */
    public function __construct(
        private readonly string $path,
        private readonly string $journalMode = 'WAL',
        private readonly ?LoggerInterface $logger = null,
    ) {
    }

    public static function fromConfig(Config $config, ?LoggerInterface $logger = null): self
    {
        return new self($config->dbPath, $config->journalMode, $logger);
    }

    public function path(): string
    {
        return $this->path;
    }

    public function pdo(): PDO
    {
        return $this->pdo ??= $this->connect();
    }

    /** Journal mode SQLite actually reports for this connection (lowercase, e.g. "wal", "delete", "memory"). */
    public function effectiveJournalMode(): string
    {
        $this->pdo();

        return $this->effectiveJournalMode;
    }

    public function close(): void
    {
        $this->pdo = null;
        $this->depth = 0;
    }

    /**
     * Runs $fn inside a BEGIN IMMEDIATE transaction (nested calls join the outer one).
     *
     * @template T
     * @param callable(PDO): T $fn
     * @return T
     */
    public function write(callable $fn): mixed
    {
        $pdo = $this->pdo();
        if ($this->depth > 0) {
            ++$this->depth;
            try {
                return $fn($pdo);
            } finally {
                --$this->depth;
            }
        }

        $pdo->exec('BEGIN IMMEDIATE');
        $this->depth = 1;
        try {
            $result = $fn($pdo);
            $pdo->exec('COMMIT');

            return $result;
        } catch (Throwable $e) {
            try {
                $pdo->exec('ROLLBACK');
            } catch (PDOException) {
                // The transaction may already be gone (e.g. SQLite rolled it back itself).
            }
            throw $e;
        } finally {
            $this->depth = 0;
        }
    }

    /**
     * @param array<int|string, scalar|null> $params
     * @return list<array<string, mixed>>
     */
    public function all(string $sql, array $params = []): array
    {
        $stmt = $this->pdo()->prepare($sql);
        $stmt->execute($params);
        /** @var list<array<string, mixed>> $rows */
        $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);

        return $rows;
    }

    /**
     * @param array<int|string, scalar|null> $params
     * @return array<string, mixed>|null
     */
    public function one(string $sql, array $params = []): ?array
    {
        $stmt = $this->pdo()->prepare($sql);
        $stmt->execute($params);
        /** @var array<string, mixed>|false $row */
        $row = $stmt->fetch(PDO::FETCH_ASSOC);

        return $row === false ? null : $row;
    }

    /**
     * @param array<int|string, scalar|null> $params
     */
    public function scalar(string $sql, array $params = []): mixed
    {
        $stmt = $this->pdo()->prepare($sql);
        $stmt->execute($params);
        $value = $stmt->fetchColumn();

        return $value === false ? null : $value;
    }

    /**
     * @param array<int|string, scalar|null> $params
     * @return int affected rows
     */
    public function exec(string $sql, array $params = []): int
    {
        $stmt = $this->pdo()->prepare($sql);
        $stmt->execute($params);

        return $stmt->rowCount();
    }

    /**
     * Runs a parameterless query (e.g. a PRAGMA) on a raw PDO handle and returns its first column.
     */
    public static function queryValue(PDO $pdo, string $sql): mixed
    {
        $stmt = $pdo->query($sql);
        if ($stmt === false) {
            throw new PDOException('Query failed: ' . $sql);
        }
        $value = $stmt->fetchColumn();

        return $value === false ? null : $value;
    }

    private function connect(): PDO
    {
        if ($this->path !== ':memory:') {
            Paths::ensureDir(dirname($this->path));
        }

        $pdo = new PDO('sqlite:' . $this->path, null, null, [
            PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
            PDO::ATTR_STRINGIFY_FETCHES => false,
        ]);
        $pdo->exec('PRAGMA busy_timeout = ' . self::BUSY_TIMEOUT_MS);
        $pdo->exec('PRAGMA foreign_keys = ON');

        $this->effectiveJournalMode = $this->applyJournalMode($pdo);
        if ($this->effectiveJournalMode === 'wal') {
            // Durable across application crashes; WAL + NORMAL only risks the last commits on power loss.
            $pdo->exec('PRAGMA synchronous = NORMAL');
        }

        return $pdo;
    }

    private function applyJournalMode(PDO $pdo): string
    {
        $current = strtolower((string) self::queryValue($pdo, 'PRAGMA journal_mode'));
        $wanted = strtolower($this->journalMode);
        if ($current === $wanted || $current === 'memory') {
            return $current;
        }

        try {
            // journal_mode is persistent in the file; switching needs no other open connection.
            $result = strtolower((string) self::queryValue($pdo, 'PRAGMA journal_mode = ' . ($wanted === 'wal' ? 'WAL' : 'DELETE')));
        } catch (PDOException $e) {
            $this->logger?->warning('Could not switch SQLite journal mode', [
                'from' => $current, 'to' => $wanted, 'error' => $e->getMessage(),
            ]);

            return $current;
        }

        if ($result !== $wanted) {
            $this->logger?->warning('SQLite refused journal mode', ['wanted' => $wanted, 'got' => $result]);
        }

        return $result;
    }
}
