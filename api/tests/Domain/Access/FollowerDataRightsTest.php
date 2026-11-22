<?php

declare(strict_types=1);

namespace Omw\Api\Tests\Domain\Access;

use Omw\Api\Domain\Access\FollowerData;
use Omw\Api\Domain\Access\Tokens;
use Omw\Api\Tests\Http\AccessTestCase;
use PHPUnit\Framework\Attributes\DataProvider;

/**
 * The D12 matrix (spec-wave5 §3.3 "D12 rights", §8.3): device state × person state × endpoint.
 * Full rights only for an active device of an active person and for a device revoked together
 * with its person; `limited` / `ended` everywhere else, and a `limited` answer never contains
 * another device's data or the person's name.
 */
final class FollowerDataRightsTest extends AccessTestCase
{
    private const DEVICE_STATES = ['pending', 'active', 'revoked_owner', 'revoked_follower', 'revoked_together', 'declined'];
    private const FOLLOWER_STATES = ['active', 'revoked'];
    private const ENDPOINTS = ['data', 'export', 'delete', 'signout', 'notice', 'consent'];
    private const T_BEFORE = '2026-11-10T08:00:00.000Z';
    private const T_PERSON = '2026-11-15T09:30:00.000Z';

    /** @return iterable<string, array{string, string, string}> */
    public static function matrix(): iterable
    {
        foreach (self::DEVICE_STATES as $device) {
            foreach (self::FOLLOWER_STATES as $follower) {
                foreach (self::ENDPOINTS as $endpoint) {
                    yield "$device device, $follower person, $endpoint" => [$device, $follower, $endpoint];
                }
            }
        }
    }

    #[DataProvider('matrix')]
    public function testRights(string $deviceState, string $followerState, string $endpoint): void
    {
        $this->bootAccess();
        $this->initStoreDirect();
        $version = $this->publishNoticeDirect();
        [$fid, $k, $did] = $this->scenario($deviceState, $followerState, $version);

        $full = ($deviceState === 'active' && $followerState === 'active') || ($deviceState === 'revoked_together' && $followerState === 'revoked');
        $usable = in_array($deviceState, ['active', 'pending'], true) && $followerState === 'active';
        $row = $this->service(\Omw\Api\Domain\Access\Devices::class)->byKey($k);
        self::assertSame($full ? 'full' : 'limited', FollowerData::rightsOf($row));

        $body = ['k' => $k];
        if ($endpoint === 'delete') {
            $body['confirm'] = 'delete-all-my-data';
        } elseif ($endpoint === 'consent') {
            $body += ['version' => $version, 'locale' => 'de'];
        }
        $res = $this->pub('me/' . $endpoint, $body);
        self::assertSame(200, $res->getStatusCode(), (string) $res->getBody());
        $raw = (string) $res->getBody();
        $answer = self::json($res);

        switch ($endpoint) {
            case 'data':
                if ($full) {
                    self::assertSame('ok', $answer['status']);
                    self::assertCount(2, $answer['data']['devices']);
                } else {
                    self::assertSame('limited', $answer['status']);
                    self::assertSame(['label', 'state', 'createdAt'], array_keys($answer['device']));
                    self::assertSame('Phone of this device', $answer['device']['label']);
                }
                break;
            case 'export':
                self::assertSame($full ? 'omw-follower-data/1' : null, $answer['format'] ?? null);
                self::assertSame($full ? null : 'ended', $answer['status'] ?? null);
                self::assertSame($full, $res->getHeaderLine('Content-Disposition') !== '');
                break;
            case 'delete':
                self::assertSame($full ? 'deleted' : 'ended', $answer['status']);
                self::assertSame($full ? 'deleted' : $followerState, $this->appDb()->scalar('SELECT state FROM followers WHERE id = ?', [$fid]));
                break;
            case 'signout':
                self::assertSame($usable ? 'signed_out' : 'ended', $answer['status']);
                $state = $this->appDb()->scalar('SELECT state FROM devices WHERE id = ?', [$did]);
                if ($usable) {
                    self::assertSame($deviceState === 'pending' ? 'declined' : 'revoked', $state);
                }
                break;
            case 'notice':
                self::assertSame($usable ? 'ok' : 'ended', $answer['status']);
                break;
            case 'consent':
                self::assertSame($usable ? ($deviceState === 'pending' ? 'pending' : 'active') : 'ended', $answer['status']);
                break;
        }
        if (!$full) {
            // Never another device's data, never its last-seen time, never the person's name.
            self::assertStringNotContainsString('Other phone', $raw);
            self::assertStringNotContainsString('2026-11-19T07:07:07.000Z', $raw);
            self::assertStringNotContainsString('Person Matrix', $raw);
        }
    }

    /**
     * F1: a forwarded link (a waiting device of the person) confirms a changed notice, by joining
     * or with me/consent. That must neither clear the re-confirmation her own devices owe (D11)
     * nor show up as her consent in the admin, in "Your data" or in the export, until the owner
     * approves that device.
     */
    public function testAWaitingDevicesConsentIsNotThePersons(): void
    {
        $this->bootAccess();
        $this->initStoreDirect();
        $v1 = $this->publishNoticeDirect();
        [$fid, $t] = $this->invite('Oma Test');
        $kA = (string) $this->join($t, $v1)['deviceKey'];
        $v2 = $this->publishNewVersion();
        self::assertSame(['version' => $v2, 'required' => true], $this->call('me/hello', $kA)['notice']);

        // Device B: the same link, forwarded; it joins (consent v2) and waits.
        $joined = $this->join($t, $v2, null, self::UA_ANDROID);
        self::assertSame('pending', $joined['status']);
        $kB = (string) $joined['deviceKey'];
        $didB = (string) $this->appDb()->scalar("SELECT id FROM devices WHERE follower_id = ? AND state = 'pending'", [$fid]);
        self::assertSame(['version' => $v2, 'required' => true], $this->call('me/hello', $kA)['notice'], 'the join of a waiting device does not count');

        // B confirms v2 again with me/consent: a limited answer, no name, no "active".
        $res = $this->pub('me/consent', ['k' => $kB, 'version' => $v2, 'locale' => 'en']);
        $raw = (string) $res->getBody();
        self::assertSame(['status' => 'pending', 'notice' => ['version' => $v2, 'required' => false]], self::json($res));
        self::assertStringNotContainsString('Oma Test', $raw);
        self::assertSame($v2, $this->call('me/notice', $kB)['confirmedVersion'], 'B sees its own confirmation');

        // The person's own record is unchanged.
        self::assertSame(['version' => $v2, 'required' => true], $this->call('me/hello', $kA)['notice']);
        self::assertSame($v1, $this->call('me/notice', $kA)['confirmedVersion']);
        self::assertSame('known_device', self::json($this->pub('join/check', ['t' => $t, 'k' => $kA]))['status']);
        self::assertTrue(self::json($this->pub('join/check', ['t' => $t, 'k' => $kA]))['noticeRequired']);
        $admin = self::json($this->admin('GET', "/api/v1/admin/followers/$fid"));
        self::assertSame(['version' => $v1], array_intersect_key((array) $admin['consent'], ['version' => 0]));
        $data = $this->call('me/data', $kA);
        self::assertSame([$v1], array_column($data['data']['consents'], 'version'));
        self::assertSame(['key' => 'consents', 'count' => 1], $data['data']['categories'][1]);
        $export = $this->call('me/export', $kA);
        self::assertSame([$v1], array_column($export['consents'], 'version'));

        // Once the owner approves B as her device, its confirmations are hers.
        $approve = $this->admin('POST', "/api/v1/admin/devices/$didB/approve", new \stdClass());
        self::assertSame(200, $approve->getStatusCode(), (string) $approve->getBody());
        self::assertSame(['version' => $v2, 'required' => false], $this->call('me/hello', $kA)['notice']);
        self::assertSame([$v1, $v2, $v2], array_column($this->call('me/data', $kA)['data']['consents'], 'version'));
    }

    /** A declined device's confirmations never become the person's. */
    public function testADeclinedDevicesConsentNeverCounts(): void
    {
        $this->bootAccess();
        $this->initStoreDirect();
        $v1 = $this->publishNoticeDirect();
        [$fid, $t] = $this->invite('Oma Test');
        $kA = (string) $this->join($t, $v1)['deviceKey'];
        $v2 = $this->publishNewVersion();
        $this->join($t, $v2, null, self::UA_ANDROID);
        $didB = (string) $this->appDb()->scalar("SELECT id FROM devices WHERE follower_id = ? AND state = 'pending'", [$fid]);
        $decline = $this->admin('POST', "/api/v1/admin/devices/$didB/decline", new \stdClass());
        self::assertSame(200, $decline->getStatusCode(), (string) $decline->getBody());
        self::assertSame(['version' => $v2, 'required' => true], $this->call('me/hello', $kA)['notice']);
        self::assertSame([$v1], array_column($this->call('me/data', $kA)['data']['consents'], 'version'));
    }

    /** Publishes a changed notice (a new version) without the admin routes. */
    private function publishNewVersion(): int
    {
        $notices = $this->service(\Omw\Api\Domain\Access\PrivacyNotices::class);
        $draft = $notices->draft();
        $draft->controller = (object) ['name' => 'Traveler (new)', 'email' => 'traveler@example.org'];
        $notices->putDraft($draft);
        $notices->publish(hash('sha256', \Omw\Api\Domain\Access\PrivacyNotices::canonical($draft)));

        return (int) $notices->currentVersion();
    }

    public function testUnknownKeyAndDeletedPersonHaveNoRights(): void
    {
        $this->bootAccess();
        $this->initStoreDirect();
        $version = $this->publishNoticeDirect();
        foreach (self::ENDPOINTS as $endpoint) {
            $body = ['k' => Tokens::token()];
            if ($endpoint === 'delete') {
                $body['confirm'] = 'delete-all-my-data';
            } elseif ($endpoint === 'consent') {
                $body += ['version' => $version, 'locale' => 'de'];
            }
            self::assertSame('ended', self::json($this->pub('me/' . $endpoint, $body))['status'], $endpoint);
        }
        self::assertSame('none', FollowerData::rightsOf(null));
    }

    /**
     * A person with this device (label "Phone of this device") and another active device.
     *
     * @return array{0: string, 1: string, 2: string} [fid, k, did]
     */
    private function scenario(string $deviceState, string $followerState, int $version): array
    {
        $db = $this->appDb();
        $fid = Tokens::followerId();
        $did = Tokens::deviceId();
        $other = Tokens::deviceId();
        $k = Tokens::token();
        $now = self::NOW;
        $db->exec("INSERT INTO followers (id, kind, state, name, created_at, updated_at) VALUES (?, 'person', 'active', 'Person Matrix', ?, ?)", [$fid, '2026-11-01T00:00:00.000Z', $now]);
        $db->exec(
            "INSERT INTO devices (id, follower_id, state, first, key_hash, label, created_at, last_seen_at) VALUES (?, ?, 'active', 1, ?, 'Other phone', ?, '2026-11-19T07:07:07.000Z')",
            [$other, $fid, Tokens::hash(Tokens::token()), '2026-11-02T00:00:00.000Z'],
        );
        $db->exec(
            "INSERT INTO devices (id, follower_id, state, first, key_hash, label, created_at) VALUES (?, ?, 'pending', 0, ?, 'Phone of this device', ?)",
            [$did, $fid, Tokens::hash($k), '2026-11-03T00:00:00.000Z'],
        );
        $db->exec('INSERT INTO consents (follower_id, device_id, notice_version, locale, confirmed_at) VALUES (?, ?, ?, ?, ?)', [$fid, $other, $version, 'de', $now]);
        match ($deviceState) {
            'pending' => null,
            'active' => $db->exec("UPDATE devices SET state = 'active' WHERE id = ?", [$did]),
            'declined' => $db->exec("UPDATE devices SET state = 'declined', decided_at = ? WHERE id = ?", [self::T_BEFORE, $did]),
            'revoked_owner' => $db->exec("UPDATE devices SET state = 'revoked', revoked_by = 'owner', revoked_at = ? WHERE id = ?", [self::T_BEFORE, $did]),
            'revoked_follower' => $db->exec("UPDATE devices SET state = 'revoked', revoked_by = 'follower', revoked_at = ? WHERE id = ?", [self::T_BEFORE, $did]),
            'revoked_together' => $db->exec("UPDATE devices SET state = 'revoked', revoked_by = 'owner', revoked_at = ? WHERE id = ?", [self::T_PERSON, $did]),
            default => self::fail($deviceState),
        };
        if ($followerState === 'revoked') {
            $db->exec("UPDATE followers SET state = 'revoked', revoked_at = ? WHERE id = ?", [self::T_PERSON, $fid]);
            $db->exec("UPDATE devices SET state = 'revoked', revoked_by = 'owner', revoked_at = ? WHERE id = ?", [self::T_PERSON, $other]);
        }

        return [$fid, $k, $did];
    }
}
