<?php

declare(strict_types=1);

namespace Omw\Api\Domain\Access;

use Omw\Api\Infra\Clock;
use Omw\Api\Infra\Db;

/**
 * Consent records (D11): which privacy notice version a person confirmed, when, in which locale
 * and on which device. Every successful join writes one; me/consent writes one for the current
 * version after a changed text.
 *
 * A confirmation counts as the PERSON's only when its device was approved (state active, or
 * revoked after having been active). A waiting device is exactly what a forwarded link produces:
 * its rows stay on that device ({@see highestVersionForDevice()}) and join the person's record
 * only when the owner approves it; a declined device's rows never do. So a forwarded link can
 * neither skip the person's re-confirmation of a changed notice nor appear as her consent.
 */
final class Consents
{
    /** The person's rows from approved devices (one placeholder: the fid). */
    private const APPROVED = "FROM consents c JOIN devices d ON d.id = c.device_id AND d.follower_id = c.follower_id
        WHERE c.follower_id = ? AND d.state IN ('active', 'revoked')";

    public function __construct(private readonly Db $db)
    {
    }

    public function record(string $fid, ?string $did, int $version, string $locale): void
    {
        $this->db->write(fn (): int => $this->db->exec(
            'INSERT INTO consents (follower_id, device_id, notice_version, locale, confirmed_at) VALUES (?, ?, ?, ?, ?)',
            [$fid, $did, $version, $locale, Clock::nowIso()],
        ));
    }

    public function highestVersion(string $fid): ?int
    {
        $v = $this->db->scalar('SELECT MAX(c.notice_version) ' . self::APPROVED, [$fid]);

        return $v === null ? null : (int) $v;
    }

    /** A waiting device only learns about its own confirmations (§3.3 D12 rights). */
    public function highestVersionForDevice(string $did): ?int
    {
        $v = $this->db->scalar('SELECT MAX(notice_version) FROM consents WHERE device_id = ?', [$did]);

        return $v === null ? null : (int) $v;
    }

    /** @return array{version: int, confirmedAt: string}|null the newest confirmation of the highest version (approved devices) */
    public function latest(string $fid): ?array
    {
        $row = $this->db->one(
            'SELECT c.notice_version, c.confirmed_at ' . self::APPROVED . ' ORDER BY c.notice_version DESC, c.confirmed_at DESC LIMIT 1',
            [$fid],
        );

        return $row === null ? null : ['version' => (int) $row['notice_version'], 'confirmedAt' => (string) $row['confirmed_at']];
    }

    /** @return list<array{version: int, confirmedAt: string, locale: string}> the person's confirmations (approved devices), oldest first */
    public function list(string $fid): array
    {
        return array_map(static fn (array $r): array => [
            'version' => (int) $r['notice_version'],
            'confirmedAt' => (string) $r['confirmed_at'],
            'locale' => (string) $r['locale'],
        ], $this->db->all('SELECT c.notice_version, c.confirmed_at, c.locale ' . self::APPROVED . ' ORDER BY c.confirmed_at, c.id', [$fid]));
    }
}
