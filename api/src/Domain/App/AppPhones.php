<?php

declare(strict_types=1);

namespace Omw\Api\Domain\App;

use Omw\Api\Domain\Alerts\Notification;
use Omw\Api\Domain\Alerts\Notifier;
use Omw\Api\Domain\Auth\ApiTokens;
use Omw\Api\Http\ApiException;
use Omw\Api\Infra\Clock;
use Omw\Api\Infra\Db;
use Psr\Log\LoggerInterface;
use stdClass;
use Throwable;

/**
 * Connected phones and their capture tokens (Q4 a), and the one-time pairing codes that connect
 * them ("Connect a phone" in the admin).
 *
 * Tokens have the same form as API tokens ("omw_" + 43 base64url characters, only the sha256 is
 * stored) but live in app_phones, never in api_tokens: AdminAuth and BackendAuth cannot accept
 * them. Scope: always ["capture"]. Expiry slides: every use (recorded at most once a minute)
 * pushes it out to {@see AppInboxConfig::TOKEN_DAYS} days.
 *
 * Pairing (app-plan §3.6): the admin makes one code with two forms (a 26-char link code for
 * omw://pair#…, an 8-char typed code), stored as sha256 hashes, single use, valid 1 h by default and
 * 24 h at most; a new code cancels the open one. Redeeming it consumes the code and creates the
 * token in one transaction, then tells the owner ("A phone was connected: …").
 *
 * Install (review R3): the app sends a random install id with the pairing (AppPairRequest.installId,
 * only its sha256 is stored). When the same install pairs again (a Disconnect after a false alarm,
 * an expired token, a lost key on the phone), the new connection takes over the entries of the
 * install's earlier connections and those connections are closed: the moments on their way
 * continue where they stopped. Another install never sees another phone's entries (Q4 a).
 */
final class AppPhones
{
    public const SCOPES = ['capture'];

    public function __construct(
        private readonly Db $db,
        private readonly Notifier $notifier,
        private readonly LoggerInterface $logger,
    ) {
    }

    // -----------------------------------------------------------------------------------------
    // Pairing codes (admin)

    /**
     * POST /admin/app-pairings (contract AppPairingCreated).
     *
     * @return array{link: string, typedCode: string, expiresAt: string}
     */
    public function createPairing(int $userId, int $ttlMinutes): array
    {
        $ttlMinutes = max(AppRules::PAIRING_TTL_MIN, min(AppRules::PAIRING_TTL_MAX, $ttlMinutes));
        $link = AppRules::randomCode(AppRules::LINK_CODE_CHARS);
        $typed = AppRules::randomCode(AppRules::TYPED_CODE_CHARS);
        $now = Clock::now();
        $expiresAt = Clock::iso($now->modify("+$ttlMinutes minutes"));
        $this->db->write(function () use ($userId, $link, $typed, $now, $expiresAt): void {
            $this->db->exec('UPDATE app_pairings SET cancelled_at = ? WHERE used_at IS NULL AND cancelled_at IS NULL', [Clock::iso($now)]);
            $this->db->exec(
                'INSERT INTO app_pairings (link_hash, typed_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?)',
                [self::codeHash($link), self::codeHash($typed), $userId, Clock::iso($now), $expiresAt],
            );
        });

        return [
            'link' => AppRules::LINK_PREFIX . $link,
            'typedCode' => AppRules::formatTypedCode($typed),
            'expiresAt' => $expiresAt,
        ];
    }

    /** @return array{expiresAt: string}|null the open (unused, unexpired, not cancelled) code */
    public function openPairing(): ?array
    {
        $expiresAt = $this->db->scalar(
            'SELECT expires_at FROM app_pairings WHERE used_at IS NULL AND cancelled_at IS NULL AND expires_at > ? ORDER BY id DESC LIMIT 1',
            [Clock::nowIso()],
        );

        return is_string($expiresAt) ? ['expiresAt' => $expiresAt] : null;
    }

    // -----------------------------------------------------------------------------------------
    // Pairing (phone)

    /**
     * POST /app/pair (contract AppPairRequest -> AppPairResponse). The caller rate-limits.
     *
     * @return array{token: string, info: array{id: int, name: string, scopes: list<string>, createdAt: string, expiresAt: string|null}}
     *
     * @throws ApiException 401 pairing_invalid (unknown, used or cancelled), 410 pairing_expired
     */
    public function pair(stdClass $body): array
    {
        $code = AppRules::normalizePairingCode((string) $body->code);
        if ($code === null) {
            throw self::invalid();
        }
        $hash = self::codeHash($code);
        $name = trim((string) $body->deviceName);
        $name = $name === '' ? 'Phone' : mb_substr($name, 0, 100);
        $token = ApiTokens::generate();
        $now = Clock::nowIso();
        $expiresAt = Clock::iso(Clock::now()->modify('+' . AppInboxConfig::TOKEN_DAYS . ' days'));

        $installHash = self::installHash($body->installId ?? null);
        $result = $this->db->write(function () use ($hash, $code, $name, $body, $token, $now, $expiresAt, $installHash): array {
            $column = strlen($code) === AppRules::LINK_CODE_CHARS ? 'link_hash' : 'typed_hash';
            $pairing = $this->db->one("SELECT * FROM app_pairings WHERE $column = ?", [$hash]);
            if ($pairing === null || $pairing['used_at'] !== null || $pairing['cancelled_at'] !== null) {
                throw self::invalid();
            }
            if ((string) $pairing['expires_at'] <= $now) {
                throw new ApiException(410, 'pairing_expired', 'This code has expired. Ask for a new one.');
            }
            $this->db->exec(
                'INSERT INTO app_phones (user_id, name, platform, app_version, token_hash, token_hint, created_at, expires_at, install_hash)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
                [(int) $pairing['user_id'], $name, (string) $body->platform, mb_substr((string) $body->appVersion, 0, 40),
                    ApiTokens::hash($token), substr($token, 0, 10) . '…', $now, $expiresAt, $installHash],
            );
            $id = (int) $this->db->pdo()->lastInsertId();
            $this->db->exec('UPDATE app_pairings SET used_at = ?, phone_id = ? WHERE id = ?', [$now, $id, (int) $pairing['id']]);
            $adopted = $installHash === null ? 0 : $this->adopt($installHash, $id, $now);

            return [
                'info' => ['id' => $id, 'name' => $name, 'scopes' => self::SCOPES, 'createdAt' => $now, 'expiresAt' => $expiresAt],
                'adopted' => $adopted,
            ];
        });
        $info = $result['info'];
        $adopted = $result['adopted'];
        if ($adopted > 0) {
            $this->logger->info('app phone {id} is an install connected before: it continues {n} entries', ['id' => $info['id'], 'n' => $adopted]);
        }

        $this->notify(new Notification(
            'app_phone_connected',
            'warning',
            'A phone was connected',
            sprintf('A phone was connected to On My Way: %s (%s).%s If this was not you, disconnect it in the admin under Settings › Connect a phone.', $name, (string) $body->platform,
                $adopted > 0 ? sprintf(' It is the same app as before; its %d moments continue.', $adopted) : ''),
            false,
            $now,
        ));

        return ['token' => $token, 'info' => $info];
    }

    // -----------------------------------------------------------------------------------------
    // Tokens

    /**
     * The active phone for a bearer token, or null (unknown, revoked, expired, owner gone).
     *
     * @return array{id: int, userId: int, name: string, expiresAt: string|null, lastUsedAt: string|null}|null
     */
    public function authenticate(string $token): ?array
    {
        if (!ApiTokens::looksLikeToken($token)) {
            return null;
        }
        $row = $this->db->one(
            'SELECT p.id, p.user_id, p.name, p.expires_at, p.last_used_at, p.revoked_at
             FROM app_phones p JOIN users u ON u.id = p.user_id WHERE p.token_hash = ?',
            [ApiTokens::hash($token)],
        );
        if ($row === null || $row['revoked_at'] !== null) {
            return null;
        }
        $expiresAt = $row['expires_at'] === null ? null : (string) $row['expires_at'];
        if ($expiresAt !== null && $expiresAt <= Clock::nowIso()) {
            return null;
        }

        return [
            'id' => (int) $row['id'],
            'userId' => (int) $row['user_id'],
            'name' => (string) $row['name'],
            'expiresAt' => $expiresAt,
            'lastUsedAt' => $row['last_used_at'] === null ? null : (string) $row['last_used_at'],
        ];
    }

    /** True when the token belongs to a phone the owner disconnected (401 token_revoked). */
    public function isRevoked(string $token): bool
    {
        return ApiTokens::looksLikeToken($token)
            && $this->db->scalar('SELECT 1 FROM app_phones WHERE token_hash = ? AND revoked_at IS NOT NULL', [ApiTokens::hash($token)]) !== null;
    }

    /** Records the use and slides the expiry, at most once per minute (keeps most requests write-free). */
    public function touch(int $id, ?string $lastUsedAt, string $ip): void
    {
        $now = Clock::now();
        if ($lastUsedAt !== null && $lastUsedAt > Clock::iso($now->modify('-60 seconds'))) {
            return;
        }
        $this->db->write(fn (): int => $this->db->exec(
            'UPDATE app_phones SET last_used_at = ?, last_used_ip = ?, expires_at = ? WHERE id = ? AND revoked_at IS NULL',
            [Clock::iso($now), $ip, Clock::iso($now->modify('+' . AppInboxConfig::TOKEN_DAYS . ' days')), $id],
        ));
    }

    /**
     * Contract AppPhone list: connected phones first (newest first), then disconnected ones.
     *
     * @return list<array<string, mixed>>
     */
    public function list(): array
    {
        $rows = $this->db->all(
            "SELECT p.*, (SELECT COUNT(*) FROM app_entries e WHERE e.phone_id = p.id) AS total,
                    (SELECT COUNT(*) FROM app_entries e WHERE e.phone_id = p.id AND e.state IN ('receiving', 'uploaded', 'fetching')) AS in_inbox
             FROM app_phones p ORDER BY (p.revoked_at IS NOT NULL), p.id DESC LIMIT 100",
        );
        $out = [];
        foreach ($rows as $row) {
            $out[] = [
                'id' => (int) $row['id'],
                'name' => (string) $row['name'],
                'platform' => (string) $row['platform'],
                'appVersion' => (string) $row['app_version'],
                'createdAt' => (string) $row['created_at'],
                'lastUsedAt' => $row['last_used_at'] === null ? null : (string) $row['last_used_at'],
                'expiresAt' => $row['expires_at'] === null ? null : (string) $row['expires_at'],
                'revokedAt' => $row['revoked_at'] === null ? null : (string) $row['revoked_at'],
                'entries' => ['total' => (int) $row['total'], 'inInbox' => (int) $row['in_inbox']],
            ];
        }

        return $out;
    }

    /** "Disconnect": revokes the phone's token. False when there is no such phone. */
    public function revoke(int $id): bool
    {
        return $this->db->write(function () use ($id): bool {
            if ($this->db->scalar('SELECT 1 FROM app_phones WHERE id = ?', [$id]) === null) {
                return false;
            }
            $this->db->exec('UPDATE app_phones SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL', [Clock::nowIso(), $id]);

            return true;
        });
    }

    /**
     * The new connection $phoneId of an install takes over the entries of the install's earlier
     * connections, which are closed (their tokens are gone from the phone anyway). Inside the
     * pairing transaction. Returns how many entries it took over.
     */
    private function adopt(string $installHash, int $phoneId, string $now): int
    {
        $earlier = array_map(
            static fn (array $r): int => (int) $r['id'],
            $this->db->all('SELECT id FROM app_phones WHERE install_hash = ? AND id <> ?', [$installHash, $phoneId]),
        );
        if ($earlier === []) {
            return 0;
        }
        $in = implode(',', array_fill(0, count($earlier), '?'));
        $adopted = $this->db->exec("UPDATE app_entries SET phone_id = ? WHERE phone_id IN ($in)", [$phoneId, ...$earlier]);
        $this->db->exec("UPDATE app_phones SET revoked_at = ? WHERE id IN ($in) AND revoked_at IS NULL", [$now, ...$earlier]);

        return $adopted;
    }

    /** sha256 of a valid install id (AppPairRequest.installId), null when absent or malformed. */
    public static function installHash(mixed $installId): ?string
    {
        if (!is_string($installId) || preg_match('/^[A-Za-z0-9_-]{22,64}$/D', $installId) !== 1) {
            return null;
        }

        return hash('sha256', 'omw-app-install:' . $installId);
    }

    public static function codeHash(string $normalizedCode): string
    {
        return hash('sha256', 'omw-app-pairing:' . $normalizedCode);
    }

    private static function invalid(): ApiException
    {
        return new ApiException(401, 'pairing_invalid', 'This code is not valid (or was already used).');
    }

    /** Best effort: pairing must not fail because ntfy or the mail server is down. */
    private function notify(Notification $notification): void
    {
        try {
            $this->notifier->send($notification);
        } catch (Throwable $e) {
            $this->logger->warning('The "phone connected" notice could not be delivered: {error}', ['error' => $e->getMessage()]);
        }
    }
}
