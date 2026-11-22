<?php

declare(strict_types=1);

namespace Omw\Api\Infra\Store;

use Omw\Api\AccessConfig;
use Omw\Api\Domain\Access\StoreLayout;

/**
 * The store over SFTP (ACCESS_STORE_MODE=sftp, P0b-2), meant for a dedicated SFTP account that
 * is restricted to the store folder (D4). {@see connect()}:
 *   1. connects with a 5 s timeout (every later operation has the same timeout);
 *   2. checks the host key: "SHA256:" + base64(sha256(raw key blob)) without padding must be one
 *      of ACCESS_STORE_SFTP_HOSTKEYS, else StoreWriterException("host_key");
 *   3. logs in with the key file (preferred) or the password; a refusal is
 *      StoreWriterException("auth"), which the applier records as writer_blocked_at and never
 *      retries until the owner presses "Retry" (the host bans repeated failed logins);
 *   4. refuses a login that can see the site docroot (StoreWriterException("site_login")) unless
 *      ACCESS_STORE_SFTP_ALLOW_SITE_LOGIN=true: the SFTP root "/" contains "_", "index.html" or
 *      ".omw-gate.json", or a ".htaccess" without a store marker next to it (a restricted account
 *      chrooted into an F3 store sees the store's own .htaccess and marker, which is fine).
 * Exclusive put = type() then put(); replace = put(temp) + posix-rename when the server offers
 * it, else delete + rename.
 */
final class SftpStoreWriter implements StoreWriter
{
    public const TIMEOUT_SECONDS = 5;

    private bool $connected = false;

    public function __construct(
        private readonly SftpClient $client,
        private readonly AccessConfig $config,
    ) {
    }

    /** "SHA256:<base64 without padding>" of a raw host key blob. */
    public static function fingerprint(string $blob): string
    {
        return 'SHA256:' . rtrim(base64_encode(hash('sha256', $blob, true)), '=');
    }

    /** @throws StoreWriterException connect | host_key | auth | site_login | config */
    public function connect(): void
    {
        $c = $this->config;
        if ($c->sftpHost === '' || $c->sftpUser === '' || $c->sftpRoot === '' || $c->sftpHostKeys === []) {
            throw new StoreWriterException('config', 'The SFTP store writer is not configured completely');
        }
        $privateKey = null;
        if ($c->sftpKeyFile !== '') {
            $privateKey = @file_get_contents($c->sftpKeyFile);
            if (!is_string($privateKey) || $privateKey === '') {
                throw new StoreWriterException('config', 'Cannot read ACCESS_STORE_SFTP_KEY_FILE');
            }
        }
        $blob = $this->client->connect($c->sftpHost, $c->sftpPort, self::TIMEOUT_SECONDS);
        if (!in_array(self::fingerprint($blob), $c->sftpHostKeys, true)) {
            $this->client->disconnect();
            throw new StoreWriterException('host_key', 'The SFTP server\'s host key is not one of ACCESS_STORE_SFTP_HOSTKEYS');
        }
        $ok = $privateKey !== null
            ? $this->client->loginWithKey($c->sftpUser, $privateKey, $c->sftpKeyPassphrase)
            : $this->client->loginWithPassword($c->sftpUser, $c->sftpPassword);
        if (!$ok) {
            $this->client->disconnect();
            throw new StoreWriterException('auth', 'The SFTP login was refused');
        }
        if (!$c->sftpAllowSiteLogin && self::looksLikeSiteRoot($this->client->nlist('/') ?? [])) {
            $this->client->disconnect();
            throw new StoreWriterException('site_login', 'This SFTP login can see the site docroot; use an account restricted to the store folder (or set ACCESS_STORE_SFTP_ALLOW_SITE_LOGIN=true)');
        }
        $this->connected = true;
    }

    /** @param list<string> $names */
    public static function looksLikeSiteRoot(array $names): bool
    {
        foreach (['_', 'index.html', '.omw-gate.json'] as $siteFile) {
            if (in_array($siteFile, $names, true)) {
                return true;
            }
        }

        return in_array('.htaccess', $names, true) && !in_array(StoreLayout::MARKER, $names, true);
    }

    /** True when the login can list anything outside the store (doctor warning). */
    public function seesOutsideStore(): bool
    {
        $this->ensureConnected();
        $parent = dirname($this->config->sftpRoot);

        return $parent !== '.' && $parent !== $this->config->sftpRoot && $this->client->nlist($parent) !== null;
    }

    public function mode(): string
    {
        return 'sftp';
    }

    public function put(string $rel, string $content, bool $exclusive): void
    {
        self::check($rel, ['marker', 'locked', 'session', 'handoff', 'personTombstone', 'deviceTombstone', 'htaccess']);
        if (!$exclusive) {
            $this->replace($rel, $content);

            return;
        }
        $this->ensureConnected();
        $path = $this->abs($rel);
        if ($this->client->type($path) !== null) {
            return;
        }
        $this->ensureParent($rel);
        if (!$this->client->put($path, $content)) {
            throw StoreWriterException::io('create', $rel);
        }
        $this->client->chmod($path, $this->config->fileMode);
    }

    public function replace(string $rel, string $content): void
    {
        self::check($rel, ['marker', 'htaccess', 'personTombstone']);
        $this->ensureConnected();
        $this->ensureParent($rel);
        $path = $this->abs($rel);
        $tmp = dirname($path) . '/.tmp-' . bin2hex(random_bytes(6));
        if (!$this->client->put($tmp, $content)) {
            throw StoreWriterException::io('create temp file for', $rel);
        }
        $this->client->chmod($tmp, $this->config->fileMode);
        if ($this->client->supportsPosixRename()) {
            $ok = $this->client->posixRename($tmp, $path);
        } else {
            $this->client->delete($path);
            $ok = $this->client->rename($tmp, $path);
        }
        if (!$ok) {
            $this->client->delete($tmp);
            throw StoreWriterException::io('replace', $rel);
        }
    }

    public function delete(string $rel): void
    {
        self::check($rel, ['locked', 'session', 'handoff', 'stray']);
        $this->ensureConnected();
        $path = $this->abs($rel);
        $type = $this->client->type($path);
        if ($type === null) {
            return;
        }
        if ($type === 'dir') {
            throw StoreWriterException::io('delete (a directory)', $rel);
        }
        if (!$this->client->delete($path) && $this->client->type($path) !== null) {
            throw StoreWriterException::io('delete', $rel);
        }
    }

    public function deletePrefix(string $relDir, string $namePrefix): int
    {
        self::check($relDir, ['sessionDir']);
        if (preg_match('/^' . StoreLayout::DID . '\.$/D', $namePrefix) !== 1) {
            throw new StoreWriterException('path', 'Invalid delete prefix');
        }
        $deleted = 0;
        foreach ($this->list($relDir) as $name) {
            if (!str_starts_with($name, $namePrefix)) {
                continue;
            }
            $path = $this->abs($relDir) . '/' . $name;
            if ($this->client->type($path) === 'dir') {
                $this->removeTree($path, $relDir . '/' . $name);
            } elseif (!$this->client->delete($path) && $this->client->type($path) !== null) {
                throw StoreWriterException::io('delete', $relDir . '/' . $name);
            }
            ++$deleted;
        }

        return $deleted;
    }

    public function deleteTree(string $relDir): void
    {
        self::check($relDir, ['sessionDir', 'stray']);
        $this->ensureConnected();
        $path = $this->abs($relDir);
        $type = $this->client->type($path);
        if ($type === 'dir') {
            $this->removeTree($path, $relDir);
        } elseif ($type !== null && !$this->client->delete($path)) {
            throw StoreWriterException::io('delete', $relDir);
        }
    }

    public function list(string $relDir): array
    {
        if (!in_array($relDir, ['', 's', 'h', 't'], true)) {
            self::check($relDir, ['sessionDir', 'stray']);
        }
        $this->ensureConnected();
        $path = $relDir === '' ? $this->config->sftpRoot : $this->abs($relDir);
        if ($this->client->type($path) !== 'dir') {
            return [];
        }
        $names = $this->client->nlist($path);
        if ($names === null) {
            throw StoreWriterException::io('list', $relDir === '' ? '/' : $relDir);
        }

        return array_values(array_filter($names, static fn (string $n): bool => !str_starts_with($n, '.tmp-')));
    }

    public function read(string $rel): ?string
    {
        self::check($rel, ['marker', 'locked', 'personTombstone', 'deviceTombstone', 'htaccess']);
        $this->ensureConnected();
        $path = $this->abs($rel);
        if ($this->client->type($path) !== 'file') {
            return null;
        }
        $data = $this->client->get($path, 4096);
        if ($data === null) {
            throw StoreWriterException::io('read', $rel);
        }

        return $data;
    }

    public function isDir(string $rel): bool
    {
        if (!in_array($rel, ['s', 'h', 't'], true)) {
            self::check($rel, ['sessionDir', 'stray']);
        }
        $this->ensureConnected();

        return $this->client->type($this->abs($rel)) === 'dir';
    }

    public function close(): void
    {
        if ($this->connected) {
            $this->client->disconnect();
            $this->connected = false;
        }
    }

    /** @param list<string> $kinds */
    private static function check(string $rel, array $kinds): void
    {
        $kind = StoreLayout::kind($rel);
        if ($kind === null || !in_array($kind, $kinds, true)) {
            throw new StoreWriterException('path', 'Refused store path ' . StoreLayout::redact($rel));
        }
    }

    private function ensureConnected(): void
    {
        if (!$this->connected) {
            $this->connect();
        }
    }

    private function abs(string $rel): string
    {
        return $this->config->sftpRoot . '/' . $rel;
    }

    private function ensureParent(string $rel): void
    {
        $dir = $this->config->sftpRoot;
        $this->ensureDir($dir);
        $parts = explode('/', $rel);
        array_pop($parts);
        foreach ($parts as $part) {
            $dir .= '/' . $part;
            $this->ensureDir($dir);
        }
    }

    private function ensureDir(string $dir): void
    {
        $type = $this->client->type($dir);
        if ($type === 'dir') {
            return;
        }
        if ($type !== null || !$this->client->mkdir($dir, $this->config->dirMode)) {
            if ($this->client->type($dir) !== 'dir') {
                throw new StoreWriterException('io', 'Cannot create a store directory');
            }

            return;
        }
        $this->client->chmod($dir, $this->config->dirMode);
    }

    private function removeTree(string $path, string $rel): void
    {
        foreach ($this->client->nlist($path) ?? [] as $name) {
            $child = $path . '/' . $name;
            if ($this->client->type($child) === 'dir') {
                $this->removeTree($child, $rel);
            } elseif (!$this->client->delete($child)) {
                throw StoreWriterException::io('delete', $rel);
            }
        }
        if (!$this->client->rmdir($path) && $this->client->type($path) !== null) {
            throw StoreWriterException::io('delete', $rel);
        }
    }
}
