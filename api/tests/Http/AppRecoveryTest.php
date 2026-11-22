<?php

declare(strict_types=1);

namespace Omw\Api\Tests\Http;

use Omw\Api\Domain\App\AppInbox;
use Omw\Api\Domain\App\AppInboxConfig;
use Omw\Api\Domain\App\AppPhones;
use Omw\Api\Domain\Auth\Sessions;
use Omw\Api\Infra\Clock;
use Omw\Api\Infra\Db;

/**
 * The recovery paths of the app inbox (review R2, R3, R6), through the real Slim app:
 * - the same app install connected again continues the entries that were on their way;
 * - another install still sees and changes only its own entries (Q4 a);
 * - a moment taken back (withdrawn) and shared again needs a new id: an id keeps its content;
 * - entries that never finish give their reserved bytes back after STALE_SLOT_HOURS, and a phone
 *   that comes back later creates them again.
 */
final class AppRecoveryTest extends ApiTestCase
{
    use AppTestHelpers;

    private const E1 = '01JD3ZQ8X4V7N2K5M9P0R6S8TW';
    private const E2 = '01JD3ZQ8X4V7N2K5M9P0R6S8TX';
    private const E3 = '01JD3ZQ8X4V7N2K5M9P0R6S8TY';
    private const INSTALL = 'k3J9_xQ2-vT8mN4pL6rS1w';
    private const OTHER_INSTALL = 'Zz9_yY8-xX7wW6vV5uU4tT';

    public function testTheSameInstallConnectedAgainContinuesWhatWasOnItsWay(): void
    {
        $tokenA = $this->pairInstall('Pixel 8a', self::INSTALL);
        $body = $this->photoEntry(self::E1, ['media', 'preview', 'original']);
        $slots = self::slots(self::json($this->phone($tokenA, 'POST', '/api/v1/app/entries', $body)));
        $files = $this->files;
        self::assertSame(204, $this->patchChunk($tokenA, $slots['media'], 0, substr($files['media'], 0, 256 * 1024))->getStatusCode());
        self::assertSame(201, $this->phone($tokenA, 'POST', '/api/v1/app/entries', self::textEntry(self::E2))->getStatusCode());

        // A false alarm: the owner disconnects the phone, then connects it again with a new code.
        $phoneA = self::json($this->admin('GET', '/api/v1/admin/app-phones'))['items'][0];
        self::assertSame(204, $this->admin('DELETE', '/api/v1/admin/app-phones/' . $phoneA['id'])->getStatusCode());
        $tokenB = $this->pairInstall('Pixel 8a', self::INSTALL);

        $head = $this->phone($tokenB, 'HEAD', '/api/v1/app/uploads/' . $slots['media']);
        self::assertSame(200, $head->getStatusCode());
        self::assertSame((string) (256 * 1024), $head->getHeaderLine('Upload-Offset'));
        $rest = substr($files['media'], 256 * 1024);
        for ($offset = 256 * 1024; $offset < strlen($files['media']); $offset += 256 * 1024) {
            self::assertSame(204, $this->patchChunk($tokenB, $slots['media'], $offset, substr($files['media'], $offset, 256 * 1024))->getStatusCode());
        }
        self::assertNotSame('', $rest);
        $this->uploadAll($tokenB, $slots['preview'], $files['preview']);
        $replay = $this->phone($tokenB, 'POST', '/api/v1/app/entries', $body);
        self::assertSame(200, $replay->getStatusCode(), (string) $replay->getBody());
        $commit = $this->phone($tokenB, 'POST', '/api/v1/app/entries/' . self::E1 . '/commit', ['roles' => ['media', 'preview']]);
        self::assertSame('uploaded', self::json($commit)['state'], (string) $commit->getBody());
        // The original (Q2 c) follows with the new token too.
        $this->uploadAll($tokenB, $slots['original'], $files['original']);
        self::assertSame(200, $this->phone($tokenB, 'POST', '/api/v1/app/entries/' . self::E1 . '/commit', ['roles' => ['original']])->getStatusCode());
        // Its other entries: states, and an Undo.
        $list = self::json($this->phone($tokenB, 'GET', '/api/v1/app/entries?ids=' . self::E1 . ',' . self::E2));
        self::assertCount(2, $list['items']);
        self::assertSame(204, $this->phone($tokenB, 'DELETE', '/api/v1/app/entries/' . self::E2)->getStatusCode());
        // The old token stays disconnected; the phone list shows one connected phone.
        self::assertError($this->phone($tokenA, 'GET', '/api/v1/app/hints'), 401, 'token_revoked');
        $phones = self::json($this->admin('GET', '/api/v1/admin/app-phones'))['items'];
        self::assertCount(1, array_filter($phones, static fn (array $p): bool => $p['revokedAt'] === null));
        self::assertSame(2, $phones[0]['entries']['total']);
    }

    public function testAnExpiredConnectionOfTheSameInstallIsTakenOverAndClosed(): void
    {
        $tokenA = $this->pairInstall('Pixel 8a', self::INSTALL);
        self::assertSame(201, $this->phone($tokenA, 'POST', '/api/v1/app/entries', $this->photoEntry(self::E1, ['media']))->getStatusCode());
        Clock::advance('+' . (AppInboxConfig::TOKEN_DAYS + 1) . ' days');
        self::assertError($this->phone($tokenA, 'GET', '/api/v1/app/hints'), 401, 'unauthorized');
        $this->logInAgain(); // the admin's session expired too
        $tokenB = $this->pairInstall('Pixel 8a', self::INSTALL);
        self::assertSame('receiving', self::json($this->phone($tokenB, 'GET', '/api/v1/app/entries/' . self::E1))['state']);
        $db = $this->service(Db::class);
        self::assertSame(1, (int) $db->scalar('SELECT COUNT(*) FROM app_phones WHERE revoked_at IS NULL'));
        self::assertSame(AppPhones::installHash(self::INSTALL), $db->scalar('SELECT install_hash FROM app_phones ORDER BY id DESC LIMIT 1'));
    }

    public function testAnotherInstallStillSeesOnlyItsOwnEntries(): void
    {
        $token = $this->pairInstall('Pixel 8a', self::INSTALL);
        $body = $this->photoEntry(self::E1, ['media', 'preview']);
        $slots = self::slots(self::json($this->phone($token, 'POST', '/api/v1/app/entries', $body)));
        // A second phone, and an older build that pairs without an install id: neither takes over.
        foreach ([$this->pairInstall('Stolen phone', self::OTHER_INSTALL), $this->pairPhone('Old build')] as $other) {
            self::assertSame(403, $this->phone($other, 'HEAD', '/api/v1/app/uploads/' . $slots['media'])->getStatusCode());
            self::assertError($this->patchChunk($other, $slots['media'], 0, substr($this->files['media'], 0, 1024)), 403, 'forbidden');
            self::assertError($this->phone($other, 'POST', '/api/v1/app/entries', $body), 409, 'entry_conflict');
            self::assertError($this->phone($other, 'GET', '/api/v1/app/entries/' . self::E1), 403, 'forbidden');
            self::assertError($this->phone($other, 'DELETE', '/api/v1/app/entries/' . self::E1), 403, 'forbidden');
        }
        self::assertSame(200, $this->phone($token, 'GET', '/api/v1/app/entries/' . self::E1)->getStatusCode());
        self::assertNull(AppPhones::installHash('too-short'));
    }

    public function testAMomentTakenBackAndSharedAgainComesWithANewId(): void
    {
        $token = $this->pairInstall('Pixel 8a', self::INSTALL);
        self::assertSame(201, $this->phone($token, 'POST', '/api/v1/app/entries', self::textEntry(self::E1))->getStatusCode());
        // Undo: withdrawn. The same id never takes other content, not even after a withdrawal.
        self::assertSame(204, $this->phone($token, 'DELETE', '/api/v1/app/entries/' . self::E1)->getStatusCode());
        $edited = self::textEntry(self::E1);
        $edited['entry']['occurredAt'] = '2026-11-20T09:59:45.000Z';
        $edited['entry']['text']['body'] = 'Arrived in Hội An! 🏮';
        self::assertError($this->phone($token, 'POST', '/api/v1/app/entries', $edited), 409, 'entry_conflict');
        // The app shares the edited draft under a new id: accepted; the old one stays withdrawn.
        $edited['entry']['entryId'] = self::E2;
        self::assertSame(201, $this->phone($token, 'POST', '/api/v1/app/entries', $edited)->getStatusCode());
        $states = self::json($this->phone($token, 'GET', '/api/v1/app/entries?ids=' . self::E1 . ',' . self::E2))['items'];
        self::assertSame(['withdrawn', 'uploaded'], array_column($states, 'state'));
        $pending = self::json($this->backend('GET', '/api/v1/backend/app/entries?archiveOnly=1'));
        self::assertSame([self::E2], array_column($pending['items'], 'entryId'));
    }

    public function testUnfinishedEntriesGiveTheirReservationBack(): void
    {
        $this->useInbox(new AppInboxConfig(maxBytes: 900 * 1024));
        $token = $this->pairInstall('Pixel 8a', self::INSTALL);
        self::assertSame(201, $this->phone($token, 'POST', '/api/v1/app/entries', $this->photoEntry(self::E1, ['media', 'preview']))->getStatusCode());
        self::assertSame(201, $this->phone($token, 'POST', '/api/v1/app/entries', $this->photoEntry(self::E2, ['media', 'preview']))->getStatusCode());
        $inbox = $this->service(AppInbox::class);
        self::assertGreaterThan(600 * 1024, $inbox->usage());
        // The phone is reset and never comes back; a new phone is connected.
        $phone = self::json($this->admin('GET', '/api/v1/admin/app-phones'))['items'][0];
        self::assertSame(204, $this->admin('DELETE', '/api/v1/admin/app-phones/' . $phone['id'])->getStatusCode());
        $fresh = $this->pairInstall('New phone', self::OTHER_INSTALL);
        self::assertError($this->phone($fresh, 'POST', '/api/v1/app/entries', $this->photoEntry(self::E3, ['media', 'preview'])), 507, 'inbox_full');

        Clock::advance('+' . (AppInboxConfig::STALE_SLOT_HOURS + 1) . ' hours');
        $result = $inbox->housekeeping(true);
        self::assertSame(2, $result['abandonedEntries'] ?? null);
        self::assertSame(0, $inbox->usage());
        self::assertSame(201, $this->phone($fresh, 'POST', '/api/v1/app/entries', $this->photoEntry(self::E3, ['media', 'preview']))->getStatusCode());
        self::assertSame(0, (int) $this->service(Db::class)->scalar("SELECT COUNT(*) FROM app_uploads WHERE entry_id IN (?, ?)", [self::E1, self::E2]));
    }

    public function testAPhoneThatComesBackAfterItsEntryWasGivenUpSendsItAgain(): void
    {
        $token = $this->pairInstall('Pixel 8a', self::INSTALL);
        $body = $this->photoEntry(self::E1, ['media']);
        $slots = self::slots(self::json($this->phone($token, 'POST', '/api/v1/app/entries', $body)));
        self::assertSame(204, $this->patchChunk($token, $slots['media'], 0, substr($this->files['media'], 0, 64 * 1024))->getStatusCode());
        Clock::advance('+73 hours');
        self::assertSame(1, $this->service(AppInbox::class)->housekeeping(true)['abandonedEntries'] ?? null);

        // Back on Wi-Fi four days later: the slot is unknown, the same create is accepted as new.
        self::assertSame(404, $this->phone($token, 'HEAD', '/api/v1/app/uploads/' . $slots['media'])->getStatusCode());
        $again = $this->phone($token, 'POST', '/api/v1/app/entries', $body);
        self::assertSame(201, $again->getStatusCode(), (string) $again->getBody());
        $media = self::slots(self::json($again))['media'];
        self::assertNotSame($slots['media'], $media);
        $this->uploadAll($token, $media, $this->files['media']);
        self::assertSame('uploaded', self::json($this->phone($token, 'POST', '/api/v1/app/entries/' . self::E1 . '/commit', ['roles' => ['media']]))['state']);
    }

    public function testAnEntryStillUploadingIsKept(): void
    {
        $token = $this->pairInstall('Pixel 8a', self::INSTALL);
        $slots = self::slots(self::json($this->phone($token, 'POST', '/api/v1/app/entries', $this->photoEntry(self::E1, ['media']))));
        Clock::advance('+70 hours');
        self::assertSame(204, $this->patchChunk($token, $slots['media'], 0, substr($this->files['media'], 0, 64 * 1024))->getStatusCode());
        Clock::advance('+3 hours');
        $result = $this->service(AppInbox::class)->housekeeping(true);
        self::assertSame(0, $result['abandonedEntries'] ?? null);
        self::assertSame((string) (64 * 1024), $this->phone($token, 'HEAD', '/api/v1/app/uploads/' . $slots['media'])->getHeaderLine('Upload-Offset'));
    }

    private function logInAgain(): void
    {
        $response = $this->request('POST', '/api/v1/admin/session', ['email' => self::ADMIN_EMAIL, 'password' => self::ADMIN_PASSWORD]);
        self::assertSame(200, $response->getStatusCode(), (string) $response->getBody());
        $this->sessionCookie = self::cookieValue($response, Sessions::COOKIE);
        $this->csrf = (string) self::json($response)['csrfToken'];
    }

    /** Connects a phone that sends an install id (AppPairRequest.installId); returns its token. */
    private function pairInstall(string $name, string $installId): string
    {
        $created = $this->admin('POST', '/api/v1/admin/app-pairings', ['ttlMinutes' => 60]);
        self::assertSame(201, $created->getStatusCode(), (string) $created->getBody());
        $typed = str_replace('-', '', (string) self::json($created)['typedCode']);
        $paired = $this->request('POST', '/api/v1/app/pair', self::pairBody($typed, $name) + ['installId' => $installId]);
        self::assertSame(201, $paired->getStatusCode(), (string) $paired->getBody());

        return (string) self::json($paired)['token'];
    }
}
