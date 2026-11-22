<?php

declare(strict_types=1);

namespace Omw\Api\Infra;

use Omw\Api\Config;
use Omw\Api\Domain\Auth\ApiTokens;
use Omw\Api\Domain\Auth\Passwords;
use Omw\Api\Domain\Auth\Users;
use Omw\Api\Domain\Access\StoreApplier;
use Omw\Api\Domain\Access\StoreLayout;
use Omw\Api\Infra\Store\SftpStoreWriter;
use Omw\Api\Infra\Store\StoreWriterException;
use Omw\Api\Infra\Store\StoreWriterFactory;
use PDO;
use Throwable;

/**
 * Environment checks for a PHP host (bin/doctor.php): PHP version and extensions, SQLite
 * features, writable directories, whether WAL works on this filesystem, upload limits, free disk,
 * migrations and first-run setup.
 *
 * The real database is never created here, only inspected if it exists (opening it applies the
 * configured journal mode, exactly like the app would). var/ and its sub-directories are created.
 * Note that the CLI may use another php.ini than the web server (upload limits, extensions).
 */
final class Doctor
{
    public const MIN_PHP = '8.3.0';
    public const REQUIRED_EXTENSIONS = ['pdo_sqlite', 'mbstring', 'fileinfo', 'json'];
    public const MIN_SQLITE = '3.24.0';       // UPSERT (INSERT ... ON CONFLICT DO UPDATE)
    public const WANT_SQLITE = '3.27.0';      // VACUUM INTO (nightly backups)
    public const MIN_UPLOAD_BYTES = 2 * 1024 * 1024;
    public const WARN_FREE_BYTES = 1024 * 1024 * 1024;
    public const FAIL_FREE_BYTES = 100 * 1024 * 1024;

    public function __construct(private readonly Config $config)
    {
    }

    /** @return list<DoctorCheck> */
    public function run(): array
    {
        $checks = [];
        $checks[] = $this->phpVersion();
        $checks[] = $this->extensions();
        $checks[] = $this->optionalExtensions();
        $checks = array_merge($checks, $this->sqlite());
        $checks[] = $this->passwordHashing();
        $checks = array_merge($checks, $this->directories());
        $checks[] = $this->walSupport();
        $checks = array_merge($checks, $this->uploads());
        $checks[] = $this->memoryLimit();
        $checks[] = $this->diskSpace();
        $checks = array_merge($checks, $this->database());
        $checks[] = $this->mail();
        $checks[] = $this->config->webCronEnabled()
            ? DoctorCheck::ok('web_cron', 'CRON_KEY set: GET|POST /api/v1/cron is enabled')
            : DoctorCheck::ok('web_cron', 'CRON_KEY not set: web-cron endpoint disabled (bin/cron.php must run from a cron job)');
        if ($this->config->isProduction() && $this->config->debug) {
            $checks[] = DoctorCheck::warn('debug', 'APP_DEBUG is on in production: error details leak to clients.', 'Set APP_DEBUG=false.');
        }

        return $checks;
    }

    /**
     * Checks that need the public URL: none of the private files may be reachable over HTTP
     * (they must answer anything but 200), and the health endpoint must answer 200.
     *
     * @return list<DoctorCheck>
     */
    public function httpExposure(string $baseUrl, HttpClient $http): array
    {
        $baseUrl = rtrim($baseUrl, '/');
        if ($baseUrl === '') {
            return [DoctorCheck::warn('http_exposure', 'Public URL unknown: cannot check which files are reachable.', 'Set APP_URL in .env (or pass --url=https://…).')];
        }
        $out = [];
        try {
            $health = $http->request('GET', $baseUrl . '/api/v1/health', [], null, 8.0);
            $out[] = $health['status'] === 200
                ? DoctorCheck::ok('http_health', "GET $baseUrl/api/v1/health -> 200")
                : DoctorCheck::fail('http_health', "GET $baseUrl/api/v1/health -> {$health['status']}", 'Check the rewrite rules (.htaccess) and the PHP version of the host.');
        } catch (Throwable $e) {
            return [DoctorCheck::warn('http_exposure', 'Self-check over HTTP not possible: ' . $e->getMessage(), 'Run the deploy script\'s checks from outside instead.')];
        }
        $exposed = [];
        foreach (self::PRIVATE_PATHS as $path) {
            try {
                $status = $http->request('GET', $baseUrl . $path, [], null, 8.0)['status'];
            } catch (Throwable) {
                continue;
            }
            if ($status === 200) {
                $exposed[] = $path;
            }
        }
        $out[] = $exposed === []
            ? DoctorCheck::ok('http_exposure', 'Not reachable over HTTP: ' . implode(' ', self::PRIVATE_PATHS))
            : DoctorCheck::fail('http_exposure', 'REACHABLE over HTTP: ' . implode(' ', $exposed), 'The .htaccess files are not active: check AllowOverride / point the document root at public/.');

        return $out;
    }

    /**
     * @param array{at: string, ok: bool}|null $last last cron run (CronRunner::last())
     */
    public static function cron(?array $last, \DateTimeImmutable $now): DoctorCheck
    {
        if ($last === null) {
            return DoctorCheck::warn('cron', 'Cron has not run yet: no alerts, backups or cleanup.', 'Run bin/cron.php every 5 minutes, or call GET /api/v1/cron?key=… from a web-cron service (docs/HOSTING.md).');
        }
        $age = $now->getTimestamp() - (new \DateTimeImmutable($last['at']))->getTimestamp();
        if ($age > 30 * 60) {
            return DoctorCheck::warn('cron', sprintf('Last cron run %s (%d min ago).', $last['at'], intdiv($age, 60)), 'Cron should run every 5 minutes.');
        }

        return $last['ok']
            ? DoctorCheck::ok('cron', 'Last cron run ' . $last['at'])
            : DoctorCheck::warn('cron', 'Last cron run ' . $last['at'] . ' had failing jobs (see var/logs/).');
    }

    /**
     * The site-store writer (spec-wave5 §3.1): reachable, marker readable with the expected store
     * id, file modes; for sftp a warning when the login can list anything outside the store.
     * Connects to the writer, so only the admin doctor (on request) runs it.
     */
    public function accessStore(StoreWriterFactory $writers, ?string $storeId): DoctorCheck
    {
        $access = $this->config->access;
        if ($access->storeMode === 'none') {
            return DoctorCheck::ok('access_store', 'ACCESS_STORE_MODE=none: the Mac writes the site store (revocations apply while it runs).');
        }
        $modes = sprintf('modes %04o/%04o', $access->dirMode, $access->fileMode);
        try {
            $writer = $writers->open();
        } catch (StoreWriterException $e) {
            return DoctorCheck::fail('access_store', 'Store writer (' . $access->storeMode . ') failed: ' . $e->reason . ': ' . $e->getMessage(), 'Check the ACCESS_STORE_* settings (docs/HOSTING.md).');
        }
        if ($writer === null) {
            return DoctorCheck::ok('access_store', 'No store writer configured.');
        }
        try {
            $marker = StoreApplier::parseMarker($writer->read(StoreLayout::MARKER));
            $outside = $writer instanceof SftpStoreWriter && $writer->seesOutsideStore();
        } catch (StoreWriterException $e) {
            return DoctorCheck::fail('access_store', 'Store not readable: ' . $e->getMessage());
        } finally {
            $writer->close();
        }
        if ($storeId === null) {
            return DoctorCheck::warn('access_store', 'The store is not initialised yet.', 'Admin → Personen → "Website-Speicher einrichten".');
        }
        if ($marker === null || $marker['storeId'] !== $storeId) {
            return DoctorCheck::fail('access_store', $marker === null ? 'The store marker is missing or unreadable.' : 'The store marker belongs to another store.', 'Check that the API and the backend name the same store folder, then initialise the store again.');
        }
        if ($outside) {
            return DoctorCheck::warn('access_store', 'Store ok (' . $modes . '), but the SFTP login can list folders outside the store.', 'Use an SFTP account restricted to the store folder (D4).');
        }

        return DoctorCheck::ok('access_store', 'Store ok (' . $access->storeMode . ', ' . $modes . ', store ' . $storeId . ').');
    }

    /** Files that must never be served (checked by {@see httpExposure()} and scripts/deploy-api.ts). */
    public const PRIVATE_PATHS = ['/.env', '/var/app.sqlite', '/var/bootstrap.json', '/composer.json', '/composer.lock', '/src/App.php', '/vendor/autoload.php', '/bin/cron.php', '/migrations/0001_init.sql', '/.omw-deploy.json'];

    /** @param list<DoctorCheck> $checks */
    public static function hasFailures(array $checks): bool
    {
        foreach ($checks as $check) {
            if ($check->status === DoctorStatus::Fail) {
                return true;
            }
        }

        return false;
    }

    private function phpVersion(): DoctorCheck
    {
        return version_compare(PHP_VERSION, self::MIN_PHP, '>=')
            ? DoctorCheck::ok('php_version', 'PHP ' . PHP_VERSION)
            : DoctorCheck::fail('php_version', 'PHP ' . PHP_VERSION . ' is too old.', 'PHP 8.3 or newer is required.');
    }

    private function extensions(): DoctorCheck
    {
        $missing = array_values(array_filter(self::REQUIRED_EXTENSIONS, static fn (string $e): bool => !extension_loaded($e)));

        return $missing === []
            ? DoctorCheck::ok('extensions', 'Loaded: ' . implode(', ', self::REQUIRED_EXTENSIONS))
            : DoctorCheck::fail('extensions', 'Missing PHP extensions: ' . implode(', ', $missing), 'Enable them in the hosting panel / php.ini.');
    }

    private function optionalExtensions(): DoctorCheck
    {
        $httpOut = extension_loaded('curl') || filter_var(ini_get('allow_url_fopen'), FILTER_VALIDATE_BOOL);

        return $httpOut
            ? DoctorCheck::ok('http_client', 'Outgoing HTTP possible (' . (extension_loaded('curl') ? 'curl' : 'allow_url_fopen') . ')')
            : DoctorCheck::warn('http_client', 'Neither curl nor allow_url_fopen: ntfy alerts cannot be sent.', 'Enable the curl extension.');
    }

    /** @return list<DoctorCheck> */
    private function sqlite(): array
    {
        if (!extension_loaded('pdo_sqlite')) {
            return [DoctorCheck::fail('sqlite', 'pdo_sqlite is not available.')];
        }

        $out = [];
        try {
            $pdo = new PDO('sqlite::memory:', null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
            $version = (string) Db::queryValue($pdo, 'SELECT sqlite_version()');
            if (version_compare($version, self::MIN_SQLITE, '<')) {
                $out[] = DoctorCheck::fail('sqlite_version', "SQLite $version is too old.", 'SQLite ' . self::MIN_SQLITE . '+ is required.');
            } elseif (version_compare($version, self::WANT_SQLITE, '<')) {
                $out[] = DoctorCheck::warn('sqlite_version', "SQLite $version: VACUUM INTO (backups) needs " . self::WANT_SQLITE . '+.');
            } else {
                $out[] = DoctorCheck::ok('sqlite_version', "SQLite $version");
            }

            try {
                $pdo->query("SELECT json_valid('{}')");
                $out[] = DoctorCheck::ok('sqlite_json', 'JSON1 functions available');
            } catch (Throwable) {
                $out[] = DoctorCheck::fail('sqlite_json', 'SQLite lacks the JSON1 functions (json_valid).', 'Use a PHP build with SQLite 3.38+ or JSON1 enabled.');
            }
        } catch (Throwable $e) {
            $out[] = DoctorCheck::fail('sqlite_version', 'Cannot open an in-memory SQLite database: ' . $e->getMessage());
        }

        return $out;
    }

    private function passwordHashing(): DoctorCheck
    {
        return Passwords::argon2idAvailable()
            ? DoctorCheck::ok('password_hash', 'Argon2id available')
            : DoctorCheck::warn('password_hash', 'Argon2id unavailable: falling back to bcrypt.', 'Fine to run; a PHP build with Argon2 support is preferred.');
    }

    /** @return list<DoctorCheck> */
    private function directories(): array
    {
        $paths = new Paths($this->config);
        try {
            $paths->ensureVar();
        } catch (Throwable $e) {
            return [DoctorCheck::fail('var_dir', $e->getMessage(), 'Make ' . $this->config->varDir . ' writable for the PHP user.')];
        }

        $out = [];
        $notWritable = [];
        foreach (array_merge([''], Paths::SUBDIRS) as $sub) {
            $dir = $paths->var($sub);
            if (!is_writable($dir)) {
                $notWritable[] = $dir;
            }
        }
        $out[] = $notWritable === []
            ? DoctorCheck::ok('var_dir', 'Writable: ' . $this->config->varDir . ' (' . implode(', ', Paths::SUBDIRS) . ')')
            : DoctorCheck::fail('var_dir', 'Not writable: ' . implode(', ', $notWritable), 'chmod/chown them for the PHP user.');

        $dbDir = dirname($this->config->dbPath);
        $out[] = is_dir($dbDir) && is_writable($dbDir)
            ? DoctorCheck::ok('db_dir', 'Database directory writable: ' . $dbDir)
            : DoctorCheck::fail('db_dir', 'Database directory missing or not writable: ' . $dbDir, 'SQLite needs to create -wal/-journal files next to the database.');

        $out[] = is_file($paths->var('.htaccess'))
            ? DoctorCheck::ok('var_protected', 'var/.htaccess denies web access')
            : DoctorCheck::warn('var_protected', 'var/.htaccess is missing.', 'Keep var/ outside the web root or restore the file.');

        return $out;
    }

    /**
     * Tries WAL with two connections on a scratch database next to the real one
     * (WAL needs shared memory and does not work on many network filesystems).
     */
    private function walSupport(): DoctorCheck
    {
        $dir = dirname($this->config->dbPath);
        if (!is_dir($dir) || !is_writable($dir)) {
            return DoctorCheck::fail('journal_mode', 'Cannot test WAL: database directory not writable.');
        }

        $file = $dir . '/.doctor-' . bin2hex(random_bytes(4)) . '.sqlite';
        $works = false;
        $error = '';
        try {
            $a = new PDO('sqlite:' . $file, null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
            $a->exec('PRAGMA busy_timeout = 2000');
            $mode = strtolower((string) Db::queryValue($a, 'PRAGMA journal_mode = WAL'));
            if ($mode === 'wal') {
                $a->exec('CREATE TABLE t (v INTEGER)');
                $a->exec('BEGIN IMMEDIATE');
                $a->exec('INSERT INTO t (v) VALUES (42)');
                $a->exec('COMMIT');
                $b = new PDO('sqlite:' . $file, null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
                $b->exec('PRAGMA busy_timeout = 2000');
                $works = (int) Db::queryValue($b, 'SELECT v FROM t') === 42;
                $b = null;
            } else {
                $error = "SQLite answered journal_mode=$mode";
            }
            $a = null;
        } catch (Throwable $e) {
            $error = $e->getMessage();
        } finally {
            foreach (['', '-wal', '-shm', '-journal'] as $suffix) {
                if (is_file($file . $suffix)) {
                    @unlink($file . $suffix);
                }
            }
        }

        $configured = $this->config->journalMode;
        if ($works) {
            return DoctorCheck::ok('journal_mode', "WAL works here; configured DB_JOURNAL_MODE=$configured");
        }
        if ($configured === 'WAL') {
            return DoctorCheck::fail('journal_mode', 'WAL does not work on this filesystem' . ($error !== '' ? " ($error)" : '') . '.', 'Set DB_JOURNAL_MODE=DELETE.');
        }

        return DoctorCheck::ok('journal_mode', 'WAL does not work here; DB_JOURNAL_MODE=DELETE is configured.');
    }

    /** @return list<DoctorCheck> */
    private function uploads(): array
    {
        if (!filter_var(ini_get('file_uploads'), FILTER_VALIDATE_BOOL)) {
            return [DoctorCheck::fail('uploads', 'file_uploads is off: the backend cannot upload previews.', 'Set file_uploads=On.')];
        }
        $upload = self::iniBytes((string) ini_get('upload_max_filesize'));
        $post = self::iniBytes((string) ini_get('post_max_size'));
        $limit = min($upload, $post > 0 ? $post : PHP_INT_MAX);
        $desc = sprintf(
            'upload_max_filesize=%s, post_max_size=%s (%s)',
            ini_get('upload_max_filesize'),
            ini_get('post_max_size'),
            PHP_SAPI === 'cli' ? 'CLI values; the web SAPI may differ' : 'web SAPI ' . PHP_SAPI,
        );

        return [$limit >= self::MIN_UPLOAD_BYTES
            ? DoctorCheck::ok('uploads', $desc)
            : DoctorCheck::warn('uploads', $desc, 'Previews need at least 2M for both settings.')];
    }

    private function memoryLimit(): DoctorCheck
    {
        $raw = (string) ini_get('memory_limit');
        $bytes = self::iniBytes($raw);

        return ($bytes < 0 || $bytes >= 64 * 1024 * 1024)
            ? DoctorCheck::ok('memory_limit', "memory_limit=$raw")
            : DoctorCheck::warn('memory_limit', "memory_limit=$raw is low.", 'Use at least 64M.');
    }

    private function diskSpace(): DoctorCheck
    {
        $free = @disk_free_space($this->config->varDir);
        if ($free === false) {
            return DoctorCheck::warn('disk_free', 'Cannot determine free disk space (disk_free_space disabled?).');
        }
        $human = self::humanBytes((int) $free);
        if ($free < self::FAIL_FREE_BYTES) {
            return DoctorCheck::fail('disk_free', "Only $human free.", 'Free up space: SQLite writes and backups will fail.');
        }

        return $free < self::WARN_FREE_BYTES
            ? DoctorCheck::warn('disk_free', "Only $human free.", 'Nightly backups need room; consider cleaning var/backups.')
            : DoctorCheck::ok('disk_free', "$human free");
    }

    /** @return list<DoctorCheck> */
    private function database(): array
    {
        $path = $this->config->dbPath;
        if (!is_file($path)) {
            return [DoctorCheck::warn('database', "No database yet at $path.", 'Run: php bin/migrate.php')];
        }

        $out = [];
        $db = new Db($path, $this->config->journalMode);
        try {
            $mode = $db->effectiveJournalMode();
            $out[] = $mode === strtolower($this->config->journalMode)
                ? DoctorCheck::ok('database', "$path (journal_mode=$mode)")
                : DoctorCheck::warn('database', "$path is in journal_mode=$mode, configured {$this->config->journalMode}.", 'Stop other writers and run php bin/migrate.php to switch.');

            $migrator = new Migrator($db, $this->config->migrationsDir());
            $pending = $migrator->pending();
            $modified = $migrator->modified();
            if ($modified !== []) {
                $out[] = DoctorCheck::warn('migrations', 'Applied migrations changed on disk: ' . implode(', ', $modified), 'Never edit applied migrations; add a new one.');
            }
            if ($pending !== []) {
                $out[] = DoctorCheck::warn('migrations', count($pending) . ' pending: ' . implode(', ', $pending), 'Run: php bin/migrate.php');

                return $out;
            }
            $out[] = DoctorCheck::ok('migrations', 'Up to date (' . count($migrator->applied()) . ' applied)');

            $users = (new Users($db))->count();
            $out[] = $users > 0
                ? DoctorCheck::ok('admin_user', "$users admin user(s)")
                : DoctorCheck::warn('admin_user', 'No admin user yet.', 'Deploy with scripts/deploy-api.ts (first-run bootstrap) or run: php bin/create-admin.php --email=you@example.com');

            $tokens = (new ApiTokens($db))->countActive('backend');
            $out[] = $tokens > 0
                ? DoctorCheck::ok('backend_token', "$tokens active backend token(s)")
                : DoctorCheck::warn('backend_token', 'No backend token yet.', 'Create one in the admin (Settings > Tokens) or run: php bin/create-token.php --kind=backend --name=home');
        } catch (Throwable $e) {
            $out[] = DoctorCheck::fail('database', 'Cannot use the database: ' . $e->getMessage());
        } finally {
            $db->close();
        }

        return $out;
    }

    private function mail(): DoctorCheck
    {
        return $this->config->mailDsn !== ''
            ? DoctorCheck::ok('mail', 'MAIL_DSN configured')
            : DoctorCheck::warn('mail', 'MAIL_DSN is not set: e-mail alerts are disabled.', 'Set MAIL_DSN/MAIL_FROM, or configure alerts.ntfy_url in the admin.');
    }

    /** php.ini shorthand ("8M", "1G", "-1") to bytes; -1 = unlimited. */
    public static function iniBytes(string $value): int
    {
        $value = trim($value);
        if ($value === '' || $value === '-1') {
            return -1;
        }
        $number = (int) $value;

        return match (strtolower(substr($value, -1))) {
            'g' => $number * 1024 * 1024 * 1024,
            'm' => $number * 1024 * 1024,
            'k' => $number * 1024,
            default => $number,
        };
    }

    private static function humanBytes(int $bytes): string
    {
        $units = ['B', 'KB', 'MB', 'GB', 'TB'];
        $i = 0;
        $value = (float) $bytes;
        while ($value >= 1024 && $i < count($units) - 1) {
            $value /= 1024;
            ++$i;
        }

        return sprintf('%.1f %s', $value, $units[$i]);
    }
}
