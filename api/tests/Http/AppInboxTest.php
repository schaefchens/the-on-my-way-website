<?php

declare(strict_types=1);

namespace Omw\Api\Tests\Http;

use Omw\Api\Domain\App\AppInbox;
use Omw\Api\Domain\App\AppInboxConfig;
use Omw\Api\Domain\App\AppRules;
use Omw\Api\Domain\App\TransferSlots;
use Omw\Api\Domain\Ids;
use Omw\Api\Infra\Clock;
use Omw\Api\Infra\Db;
use Omw\Api\Infra\Paths;

/**
 * The app inbox end to end through the real Slim app (every JSON response is validated against
 * api/schemas in APP_ENV=test): create, tus chunks, commit, the backend's pull, ack, withdraw,
 * reject, the visibility rules of Q4 a, the clock rules, the budget and the transfer slot.
 */
final class AppInboxTest extends ApiTestCase
{
    use AppTestHelpers;

    private const E1 = '01JD3ZQ8X4V7N2K5M9P0R6S8TW';
    private const E2 = '01JD3ZQ8X4V7N2K5M9P0R6S8TX';
    private const E3 = '01JD3ZQ8X4V7N2K5M9P0R6S8TY';

    public function testAPhotoTravelsFromThePhoneThroughTheInboxIntoTheArchive(): void
    {
        $token = $this->pairPhone();
        $created = $this->phone($token, 'POST', '/api/v1/app/entries', $this->photoEntry(self::E1));
        self::assertSame(201, $created->getStatusCode(), (string) $created->getBody());
        $state = self::json($created);
        self::assertSame('receiving', $state['state']);
        self::assertSame('app:' . self::E1, $state['sourceKey']);
        self::assertNull($state['publish']);
        $slots = self::slots($state);
        self::assertSame(['media', 'original', 'preview'], array_keys($slots));

        // HEAD: nothing yet
        $head = $this->phone($token, 'HEAD', '/api/v1/app/uploads/' . $slots['media']);
        self::assertSame(200, $head->getStatusCode());
        self::assertSame('0', $head->getHeaderLine('Upload-Offset'));
        self::assertSame((string) strlen($this->files['media']), $head->getHeaderLine('Upload-Length'));
        self::assertSame('1.0.0', $head->getHeaderLine('Tus-Resumable'));

        $files = $this->files;
        $this->uploadAll($token, $slots['media'], $files['media']);
        $this->uploadAll($token, $slots['preview'], $files['preview']);

        $commit = $this->phone($token, 'POST', '/api/v1/app/entries/' . self::E1 . '/commit', ['roles' => ['media', 'preview']]);
        self::assertSame(200, $commit->getStatusCode(), (string) $commit->getBody());
        self::assertSame('uploaded', self::json($commit)['state']);

        // The backend pulls it (and reports its archive-only switch).
        $list = $this->backend('GET', '/api/v1/backend/app/entries?archiveOnly=1');
        self::assertSame(200, $list->getStatusCode(), (string) $list->getBody());
        $items = self::json($list)['items'];
        self::assertIsArray($items);
        self::assertCount(1, $items);
        self::assertSame(self::E1, $items[0]['entryId']);
        self::assertSame('Pixel 8a', $items[0]['phone']['name']);
        self::assertSame('Lanterns in Hội An', $items[0]['entry']['caption']);

        $content = $this->backend('GET', '/api/v1/backend/app/uploads/' . $slots['media'] . '/content');
        self::assertSame(200, $content->getStatusCode());
        self::assertSame($files['media'], (string) $content->getBody());
        self::assertSame(hash('sha256', $files['media']), $content->getHeaderLine('X-Omw-Sha256'));
        self::assertSame('image/jpeg', $content->getHeaderLine('Content-Type'));
        self::assertSame('fetching', $this->appState($token, self::E1)['state']);
        $content->getBody()->close(); // end of the request: its transfer slot is free again

        // Range resume
        $range = $this->request('GET', '/api/v1/backend/app/uploads/' . $slots['media'] . '/content', null, [
            'Authorization' => 'Bearer ' . $this->backendToken(), 'Range' => 'bytes=1000-',
        ]);
        self::assertSame(206, $range->getStatusCode());
        self::assertSame(substr($files['media'], 1000), (string) $range->getBody());
        self::assertSame(sprintf('bytes 1000-%d/%d', strlen($files['media']) - 1, strlen($files['media'])), $range->getHeaderLine('Content-Range'));
        $range->getBody()->close();
        $bad = $this->request('GET', '/api/v1/backend/app/uploads/' . $slots['media'] . '/content', null, [
            'Authorization' => 'Bearer ' . $this->backendToken(), 'Range' => 'bytes=99999999-',
        ]);
        self::assertError($bad, 416, 'range_not_satisfiable');

        // The original is not committed yet: it cannot be downloaded.
        self::assertError($this->backend('GET', '/api/v1/backend/app/uploads/' . $slots['original'] . '/content'), 409, 'conflict');

        $ack = $this->backend('POST', '/api/v1/backend/app/entries/' . self::E1 . '/ack', ['roles' => ['media', 'preview']]);
        self::assertSame(204, $ack->getStatusCode(), (string) $ack->getBody());
        self::assertSame(204, $this->backend('POST', '/api/v1/backend/app/entries/' . self::E1 . '/ack', ['roles' => ['media', 'preview']])->getStatusCode(), 'replayed ack');
        $state = $this->appState($token, self::E1);
        self::assertSame('archived', $state['state']);
        self::assertTrue($this->slotOf($state, 'media')['archived']);
        self::assertFalse(is_file($this->partPath(self::E1, $slots['media'])), 'acked bytes are deleted');
        self::assertSame([], self::json($this->backend('GET', '/api/v1/backend/app/entries'))['items']);

        // Later, on Wi-Fi: the original (Q2 c) follows on its own.
        $this->uploadAll($token, $slots['original'], $files['original']);
        self::assertSame(200, $this->phone($token, 'POST', '/api/v1/app/entries/' . self::E1 . '/commit', ['roles' => ['original']])->getStatusCode());
        $items = self::json($this->backend('GET', '/api/v1/backend/app/entries'))['items'];
        self::assertIsArray($items);
        self::assertCount(1, $items);
        self::assertSame('archived', $items[0]['state']);
        $original = $this->backend('GET', '/api/v1/backend/app/uploads/' . $slots['original'] . '/content');
        self::assertSame($files['original'], (string) $original->getBody());
        $original->getBody()->close();
        self::assertSame(204, $this->backend('POST', '/api/v1/backend/app/entries/' . self::E1 . '/ack', ['roles' => ['original']])->getStatusCode());
        self::assertTrue($this->slotOf($this->appState($token, self::E1), 'original')['archived']);
        self::assertSame([], self::json($this->backend('GET', '/api/v1/backend/app/entries'))['items']);
        self::assertSame(0, $this->service(AppInbox::class)->usage());
    }

    public function testCreateIsIdempotentPerEntryIdAndHash(): void
    {
        $token = $this->pairPhone();
        $body = $this->photoEntry(self::E1);
        $first = $this->phone($token, 'POST', '/api/v1/app/entries', $body);
        self::assertSame(201, $first->getStatusCode());
        $again = $this->phone($token, 'POST', '/api/v1/app/entries', $body);
        self::assertSame(200, $again->getStatusCode(), (string) $again->getBody());
        self::assertSame(self::slots(self::json($first)), self::slots(self::json($again)));

        $changed = $body;
        $changed['entry']['caption'] = 'Something else';
        self::assertError($this->phone($token, 'POST', '/api/v1/app/entries', $changed), 409, 'entry_conflict');

        $other = $this->pairPhone('Second phone');
        self::assertError($this->phone($other, 'POST', '/api/v1/app/entries', $body), 409, 'entry_conflict');
    }

    public function testTheEntryRulesAndLimitsAreEnforced(): void
    {
        $token = $this->pairPhone();
        $voiceCaption = $this->photoEntry(self::E1, ['media'], ['kind' => 'voice', 'media' => ['seconds' => 12.5, 'ptt' => true]]);
        $voiceCaption['entry']['files'][0]['mimetype'] = 'audio/mp4';
        $response = $this->phone($token, 'POST', '/api/v1/app/entries', $voiceCaption);
        self::assertError($response, 422, 'validation_failed');
        self::assertStringContainsString('/entry/caption', (string) $response->getBody());

        $badZone = $this->photoEntry(self::E1, ['media'], ['tz' => 'Mars/Olympus']);
        self::assertError($this->phone($token, 'POST', '/api/v1/app/entries', $badZone), 422, 'validation_failed');

        $coords = $this->photoEntry(self::E1, ['media'], ['lat' => 15.88]);
        self::assertError($this->phone($token, 'POST', '/api/v1/app/entries', $coords), 422, 'validation_failed');
    }

    public function testChunksFollowTheTusSubset(): void
    {
        $token = $this->pairPhone();
        $state = self::json($this->phone($token, 'POST', '/api/v1/app/entries', $this->photoEntry(self::E1, ['media'])));
        $id = self::slots($state)['media'];
        $bytes = $this->files['media'];
        $chunk = substr($bytes, 0, 256 * 1024);

        // wrong offset -> 409 with the stored offset
        $wrong = $this->patchChunk($token, $id, 1000, $chunk);
        self::assertError($wrong, 409, 'offset_mismatch');
        self::assertSame('0', $wrong->getHeaderLine('Upload-Offset'));

        // bad digest -> 460, nothing appended
        $digest = $this->patchChunk($token, $id, 0, $chunk, ['Upload-Checksum' => AppRules::formatUploadChecksum(str_repeat('0', 64))]);
        self::assertError($digest, 460, 'checksum_mismatch');
        self::assertSame('0', $digest->getHeaderLine('Upload-Offset'));
        self::assertSame(0, filesize($this->partPath(self::E1, $id)));

        // wrong content type, wrong tus version, missing checksum, body shorter than announced
        self::assertError($this->patchChunk($token, $id, 0, $chunk, ['Content-Type' => 'application/octet-stream']), 415, 'unsupported_media_type');
        self::assertError($this->patchChunk($token, $id, 0, $chunk, ['Tus-Resumable' => '0.2.2']), 412, 'tus_version');
        self::assertError($this->patchChunk($token, $id, 0, $chunk, ['Upload-Checksum' => 'md5 1B2M2Y8AsgTpgAmY7PhCfg==']), 400, 'checksum_required');
        self::assertError($this->patchChunk($token, $id, 0, $chunk, ['Content-Length' => (string) (strlen($chunk) + 10)]), 400, 'incomplete_chunk');

        // a chunk running past the end of the file
        $tooFar = $this->patchChunk($token, $id, 0, $bytes . 'x');
        self::assertError($tooFar, 413, 'upload_too_large');

        // the real chunk, then its replay (a lost response): 409 with the new offset
        self::assertSame(204, $this->patchChunk($token, $id, 0, $chunk)->getStatusCode());
        $replay = $this->patchChunk($token, $id, 0, $chunk);
        self::assertError($replay, 409, 'offset_mismatch');
        self::assertSame((string) strlen($chunk), $replay->getHeaderLine('Upload-Offset'));

        // hosts that block PATCH/HEAD: POST + X-HTTP-Method-Override
        $rest = substr($bytes, strlen($chunk));
        $override = $this->request('POST', '/api/v1/app/uploads/' . $id, $rest, [
            'Authorization' => 'Bearer ' . $token,
            'X-HTTP-Method-Override' => 'PATCH',
            'Tus-Resumable' => '1.0.0',
            'Content-Type' => 'application/offset+octet-stream',
            'Content-Length' => (string) strlen($rest),
            'Upload-Offset' => (string) strlen($chunk),
            'Upload-Checksum' => AppRules::formatUploadChecksum(hash('sha256', $rest)),
        ]);
        self::assertSame(204, $override->getStatusCode(), (string) $override->getBody());
        self::assertSame((string) strlen($bytes), $override->getHeaderLine('Upload-Offset'));
        $head = $this->request('POST', '/api/v1/app/uploads/' . $id, null, ['Authorization' => 'Bearer ' . $token, 'X-HTTP-Method-Override' => 'HEAD']);
        self::assertSame((string) strlen($bytes), $head->getHeaderLine('Upload-Offset'));
        self::assertSame($bytes, (string) file_get_contents($this->partPath(self::E1, $id)));
    }

    public function testCommitNeedsEveryByteAndTheRightHash(): void
    {
        $token = $this->pairPhone();
        $state = self::json($this->phone($token, 'POST', '/api/v1/app/entries', $this->photoEntry(self::E1, ['media'])));
        $id = self::slots($state)['media'];
        $bytes = $this->files['media'];

        $early = $this->phone($token, 'POST', '/api/v1/app/entries/' . self::E1 . '/commit', ['roles' => ['media']]);
        self::assertError($early, 409, 'incomplete');

        // Chunks that each match their own digest but add up to other bytes than declared.
        $wrong = str_repeat('x', strlen($bytes));
        $this->uploadAll($token, $id, $wrong);
        $commit = $this->phone($token, 'POST', '/api/v1/app/entries/' . self::E1 . '/commit', ['roles' => ['media']]);
        self::assertError($commit, 422, 'sha256_mismatch');
        self::assertSame('0', $this->phone($token, 'HEAD', '/api/v1/app/uploads/' . $id)->getHeaderLine('Upload-Offset'));

        $this->uploadAll($token, $id, $bytes);
        self::assertSame('uploaded', self::json($this->phone($token, 'POST', '/api/v1/app/entries/' . self::E1 . '/commit', ['roles' => ['media']]))['state']);
        self::assertSame(200, $this->phone($token, 'POST', '/api/v1/app/entries/' . self::E1 . '/commit', ['roles' => ['media']])->getStatusCode(), 'replayed commit');
        self::assertError($this->phone($token, 'POST', '/api/v1/app/entries/' . self::E1 . '/commit', ['roles' => ['preview']]), 422, 'validation_failed');
    }

    public function testATextStatusNeedsNoUpload(): void
    {
        $token = $this->pairPhone();
        $created = $this->phone($token, 'POST', '/api/v1/app/entries', self::textEntry(self::E2));
        self::assertSame(201, $created->getStatusCode(), (string) $created->getBody());
        self::assertSame('uploaded', self::json($created)['state']);
        self::assertSame([], self::json($created)['uploads']);

        $items = self::json($this->backend('GET', '/api/v1/backend/app/entries'))['items'];
        self::assertIsArray($items);
        self::assertSame('Arrived in Hội An!', $items[0]['entry']['text']['body']);
        self::assertSame(204, $this->backend('POST', '/api/v1/backend/app/entries/' . self::E2 . '/ack', ['roles' => []])->getStatusCode());
        self::assertSame('archived', $this->appState($token, self::E2)['state']);
    }

    public function testWithdrawBeforeAndAfterTheArchive(): void
    {
        $token = $this->pairPhone();
        // Before the backend fetched it: the bytes go, nothing is relayed.
        $state = self::json($this->phone($token, 'POST', '/api/v1/app/entries', $this->photoEntry(self::E1, ['media'])));
        $id = self::slots($state)['media'];
        $this->uploadAll($token, $id, $this->files['media']);
        self::assertSame(204, $this->phone($token, 'DELETE', '/api/v1/app/entries/' . self::E1)->getStatusCode());
        self::assertSame(204, $this->phone($token, 'DELETE', '/api/v1/app/entries/' . self::E1)->getStatusCode(), 'withdraw twice');
        self::assertSame('withdrawn', $this->appState($token, self::E1)['state']);
        self::assertFalse(is_file($this->partPath(self::E1, $id)));
        self::assertError($this->patchChunk($token, $id, 0, 'abc'), 410, 'gone');
        self::assertSame([], self::json($this->backend('GET', '/api/v1/backend/app/entries'))['items']);

        // After the ack: the backend learns it (ingest.on_revoke applies there) and confirms.
        self::assertSame(201, $this->phone($token, 'POST', '/api/v1/app/entries', self::textEntry(self::E2))->getStatusCode());
        self::assertSame(204, $this->backend('POST', '/api/v1/backend/app/entries/' . self::E2 . '/ack', ['roles' => []])->getStatusCode());
        self::assertSame(204, $this->phone($token, 'DELETE', '/api/v1/app/entries/' . self::E2)->getStatusCode());
        $items = self::json($this->backend('GET', '/api/v1/backend/app/entries'))['items'];
        self::assertIsArray($items);
        self::assertCount(1, $items);
        self::assertSame(self::E2, $items[0]['entryId']);
        self::assertSame('withdrawn', $items[0]['state']);
        self::assertSame(self::NOW, $items[0]['withdrawnAt']);
        self::assertSame(204, $this->backend('POST', '/api/v1/backend/app/entries/' . self::E2 . '/ack', ['roles' => [], 'withdrawal' => true])->getStatusCode());
        self::assertSame([], self::json($this->backend('GET', '/api/v1/backend/app/entries'))['items']);

        // Withdrawn while the backend downloaded: its ack gets 410 and the withdrawal is relayed.
        $state = self::json($this->phone($token, 'POST', '/api/v1/app/entries', $this->photoEntry(self::E3, ['media'])));
        $id = self::slots($state)['media'];
        $this->uploadAll($token, $id, $this->files['media']);
        $this->phone($token, 'POST', '/api/v1/app/entries/' . self::E3 . '/commit', ['roles' => ['media']]);
        (string) $this->backend('GET', '/api/v1/backend/app/uploads/' . $id . '/content')->getBody();
        self::assertSame(204, $this->phone($token, 'DELETE', '/api/v1/app/entries/' . self::E3)->getStatusCode());
        self::assertError($this->backend('POST', '/api/v1/backend/app/entries/' . self::E3 . '/ack', ['roles' => ['media']]), 410, 'gone');
        $items = self::json($this->backend('GET', '/api/v1/backend/app/entries'))['items'];
        self::assertIsArray($items);
        self::assertSame(self::E3, $items[0]['entryId']);
        self::assertNotNull($items[0]['withdrawnAt']);
    }

    public function testTheBackendCanPurgeAnAppEntryForGood(): void
    {
        $token = $this->pairPhone();
        // One entry with bytes still in the inbox, one archived text status.
        $state = self::json($this->phone($token, 'POST', '/api/v1/app/entries', $this->photoEntry(self::E1, ['media'])));
        $id = self::slots($state)['media'];
        $this->uploadAll($token, $id, $this->files['media']);
        self::assertTrue(is_file($this->partPath(self::E1, $id)));
        self::assertSame(201, $this->phone($token, 'POST', '/api/v1/app/entries', self::textEntry(self::E2))->getStatusCode());
        self::assertSame(204, $this->backend('POST', '/api/v1/backend/app/entries/' . self::E2 . '/ack', ['roles' => []])->getStatusCode());

        foreach ([self::E1, self::E2] as $entryId) {
            self::assertSame(204, $this->backend('DELETE', '/api/v1/backend/captures/' . rawurlencode('app:' . $entryId))->getStatusCode());
            self::assertSame(204, $this->backend('DELETE', '/api/v1/backend/captures/' . rawurlencode('app:' . $entryId))->getStatusCode(), 'twice');
        }
        $db = $this->service(Db::class);
        self::assertSame(0, (int) $db->scalar('SELECT COUNT(*) FROM app_entries'));
        self::assertSame(0, (int) $db->scalar('SELECT COUNT(*) FROM app_uploads'));
        self::assertFalse(is_file($this->partPath(self::E1, $id)));
        self::assertSame([], self::json($this->backend('GET', '/api/v1/backend/app/entries'))['items']);
        self::assertSame(404, $this->phone($token, 'GET', '/api/v1/app/entries/' . self::E2)->getStatusCode());
    }

    public function testTheBackendCanRejectAnEntry(): void
    {
        $token = $this->pairPhone();
        $state = self::json($this->phone($token, 'POST', '/api/v1/app/entries', $this->photoEntry(self::E1, ['media'])));
        $this->uploadAll($token, self::slots($state)['media'], $this->files['media']);
        $this->phone($token, 'POST', '/api/v1/app/entries/' . self::E1 . '/commit', ['roles' => ['media']]);
        self::assertSame(204, $this->backend('POST', '/api/v1/backend/app/entries/' . self::E1 . '/reject', ['reason' => 'The photo cannot be decoded.'])->getStatusCode());
        $state = $this->appState($token, self::E1);
        self::assertSame('rejected', $state['state']);
        self::assertSame('The photo cannot be decoded.', $state['rejectReason']);
        self::assertSame(0, $this->service(AppInbox::class)->usage());
    }

    public function testTheAppOnlyTightensItsOwnEntries(): void
    {
        $token = $this->pairPhone();
        self::assertSame(201, $this->phone($token, 'POST', '/api/v1/app/entries', self::textEntry(self::E1))->getStatusCode());
        $key = rawurlencode('app:' . self::E1);

        $hidden = $this->phone($token, 'PUT', '/api/v1/app/visibility/' . $key, ['visibility' => 'pending']);
        self::assertSame(200, $hidden->getStatusCode(), (string) $hidden->getBody());
        self::assertSame(200, $this->phone($token, 'PUT', '/api/v1/app/visibility/' . $key, ['visibility' => 'hidden'])->getStatusCode());
        $feed = self::json($this->backend('GET', '/api/v1/backend/changes?after=0&limit=1000'));
        $annotation = array_values(array_filter($feed['items'], static fn (array $i): bool => $i['entity'] === 'annotation'));
        self::assertSame('hidden', end($annotation)['data']['visibility']);

        // Loosening needs the owner.
        self::assertError($this->phone($token, 'PUT', '/api/v1/app/visibility/' . $key, ['visibility' => 'pending']), 403, 'needs_owner');
        self::assertError($this->phone($token, 'PUT', '/api/v1/app/visibility/' . $key, ['visibility' => 'public']), 422, 'validation_failed');
        // WhatsApp captures and other phones' entries: never.
        $this->putCapture('3EB0WA', '2026-11-20T08:00:00.000Z');
        self::assertError($this->phone($token, 'PUT', '/api/v1/app/visibility/' . rawurlencode('wa:3EB0WA'), ['visibility' => 'hidden']), 403, 'forbidden');
        $other = $this->pairPhone('Stolen phone');
        self::assertError($this->phone($other, 'PUT', '/api/v1/app/visibility/' . $key, ['visibility' => 'hidden']), 403, 'forbidden');
        self::assertError($this->phone($other, 'GET', '/api/v1/app/entries/' . self::E1), 403, 'forbidden');
        self::assertError($this->phone($other, 'DELETE', '/api/v1/app/entries/' . self::E1), 403, 'forbidden');

        // Once the owner decided in the admin, the app cannot change it any more.
        self::assertSame(201, $this->phone($token, 'POST', '/api/v1/app/entries', self::textEntry(self::E2))->getStatusCode());
        $this->backend('POST', '/api/v1/backend/app/entries/' . self::E2 . '/ack', ['roles' => []]);
        $mirror = self::capture('x', '2026-11-20T09:59:30.000Z', ['sourceKey' => 'app:' . self::E2, 'publicId' => Ids::publicIdForSourceKey('app:' . self::E2)]);
        $put = $this->backend('PUT', '/api/v1/backend/captures/' . rawurlencode('app:' . self::E2), $mirror);
        self::assertContains($put->getStatusCode(), [201, 204], (string) $put->getBody());
        self::assertSame(200, $this->admin('PATCH', '/api/v1/admin/captures/' . rawurlencode('app:' . self::E2), ['visibility' => 'public'])->getStatusCode());
        self::assertError($this->phone($token, 'PUT', '/api/v1/app/visibility/' . rawurlencode('app:' . self::E2), ['visibility' => 'hidden']), 403, 'owner_decided');
    }

    public function testThePhonesClockIsCorrectedAndOldEntriesAreHeldBack(): void
    {
        $token = $this->pairPhone();
        // Phone clock 3 minutes ahead: occurredAt is moved back by the skew.
        $body = $this->photoEntry(self::E1, ['media'], ['occurredAt' => '2026-11-20T10:02:59.000Z'], '2026-11-20T10:03:00.000Z');
        self::assertSame('2026-11-20T09:59:59.000Z', self::json($this->phone($token, 'POST', '/api/v1/app/entries', $body))['occurredAt']);

        // A phone set to the wrong year cannot backdate an entry.
        $wrongYear = $this->photoEntry(self::E2, ['media'], ['occurredAt' => '2025-11-20T09:00:00.000Z'], '2025-11-20T10:00:00.000Z');
        $state = self::json($this->phone($token, 'POST', '/api/v1/app/entries', $wrongYear));
        self::assertSame(self::NOW, $state['occurredAt']);
        self::assertFalse($state['heldBack']);

        // Shared 40 days ago and only sent now: accepted as "Hold back".
        $old = $this->photoEntry(self::E3, ['media'], ['occurredAt' => '2026-10-11T10:00:00.000Z']);
        $state = self::json($this->phone($token, 'POST', '/api/v1/app/entries', $old));
        self::assertTrue($state['heldBack']);
        self::assertSame('2026-10-11T10:00:00.000Z', $state['occurredAt']);
        $info = self::json($this->admin('GET', '/api/v1/admin/app-entries/' . rawurlencode('app:' . self::E3)));
        self::assertTrue($info['heldBack']);
        self::assertSame('pending', $info['appVisibility']);
        self::assertSame('Pixel 8a', $info['phone']['name']);
    }

    public function testHintsDescribeTheInboxAndTheBackendsSwitch(): void
    {
        $token = $this->pairPhone();
        $hints = self::json($this->phone($token, 'GET', '/api/v1/app/hints'));
        self::assertTrue($hints['archiveOnly'], 'archive-only until the backend says otherwise (Q8 a)');
        self::assertNull($hints['backendLastSeenAt']);
        self::assertSame(AppInboxConfig::DEFAULT_MAX_BYTES, $hints['inboxFreeBytes']);
        self::assertSame(AppInboxConfig::DEFAULT_MAX_BYTES / 2, $hints['fileMaxBytes']);
        self::assertSame(AppRules::CHUNK_MIN_BYTES, $hints['chunk']['minBytes']);

        $this->backend('GET', '/api/v1/backend/app/entries?archiveOnly=0');
        $hints = self::json($this->phone($token, 'GET', '/api/v1/app/hints'));
        self::assertFalse($hints['archiveOnly']);
        self::assertSame(self::NOW, $hints['backendLastSeenAt']);
        $this->backend('GET', '/api/v1/backend/app/entries?archiveOnly=1');
        self::assertTrue(self::json($this->phone($token, 'GET', '/api/v1/app/hints'))['archiveOnly']);
    }

    public function testTheInboxBudgetAnswers413And507(): void
    {
        $this->useInbox(new AppInboxConfig(maxBytes: 900 * 1024));
        $token = $this->pairPhone();
        // One file above half the budget: nothing is stored, the app may resend without it.
        $tooBig = $this->phone($token, 'POST', '/api/v1/app/entries', $this->photoEntry(self::E1));
        self::assertError($tooBig, 413, 'upload_too_large');
        self::assertSame('original', self::json($tooBig)['error']['details']['role']);
        self::assertSame(201, $this->phone($token, 'POST', '/api/v1/app/entries', $this->photoEntry(self::E1, ['media', 'preview']))->getStatusCode());
        self::assertSame(201, $this->phone($token, 'POST', '/api/v1/app/entries', $this->photoEntry(self::E2, ['media', 'preview']))->getStatusCode());
        // 2 x 320 KiB reserved of 900 KiB; a third does not fit any more.
        $full = $this->phone($token, 'POST', '/api/v1/app/entries', $this->photoEntry(self::E3, ['media', 'preview']));
        self::assertError($full, 507, 'inbox_full');
        self::assertSame((string) AppInbox::RETRY_FULL_SECONDS, $full->getHeaderLine('Retry-After'));
    }

    public function testABusyTransferSlotAnswers503WithRetryAfter(): void
    {
        $token = $this->pairPhone();
        $state = self::json($this->phone($token, 'POST', '/api/v1/app/entries', $this->photoEntry(self::E1, ['media'])));
        $slot = $this->service(TransferSlots::class)->acquire();
        try {
            $busy = $this->patchChunk($token, self::slots($state)['media'], 0, substr($this->files['media'], 0, 1024));
            self::assertError($busy, 503, 'transfer_busy');
            self::assertGreaterThanOrEqual(TransferSlots::RETRY_AFTER_MIN, (int) $busy->getHeaderLine('Retry-After'));
            // JSON requests never need a slot.
            self::assertSame(200, $this->phone($token, 'GET', '/api/v1/app/entries/' . self::E1)->getStatusCode());
        } finally {
            TransferSlots::release($slot);
        }
        self::assertSame(204, $this->patchChunk($token, self::slots($state)['media'], 0, substr($this->files['media'], 0, 1024))->getStatusCode());
    }

    public function testAnOriginalCanBeLeftOutAndStalePartialUploadsStartAgain(): void
    {
        $token = $this->pairPhone();
        $state = self::json($this->phone($token, 'POST', '/api/v1/app/entries', $this->photoEntry(self::E1)));
        $slots = self::slots($state);
        self::assertError($this->phone($token, 'DELETE', '/api/v1/app/uploads/' . $slots['media']), 409, 'conflict');
        self::assertSame(204, $this->phone($token, 'DELETE', '/api/v1/app/uploads/' . $slots['original'])->getStatusCode());
        self::assertArrayNotHasKey('original', self::slots($this->appState($token, self::E1)));

        // A stale partial original starts again from 0 (its moment is home already).
        $home = self::json($this->phone($token, 'POST', '/api/v1/app/entries', $this->photoEntry(self::E2)));
        $slots2 = self::slots($home);
        $this->uploadAll($token, $slots2['media'], $this->files['media']);
        $this->uploadAll($token, $slots2['preview'], $this->files['preview']);
        self::assertSame('uploaded', self::json($this->phone($token, 'POST', '/api/v1/app/entries/' . self::E2 . '/commit', ['roles' => ['media', 'preview']]))['state']);
        self::assertSame(204, $this->patchChunk($token, $slots2['original'], 0, substr($this->files['original'], 0, 4096))->getStatusCode());
        Clock::advance('+73 hours');
        $result = $this->service(AppInbox::class)->housekeeping(true);
        self::assertSame(1, $result['staleSlots'] ?? null);
        self::assertSame('0', $this->phone($token, 'HEAD', '/api/v1/app/uploads/' . $slots2['original'])->getHeaderLine('Upload-Offset'));
        self::assertSame(0, filesize($this->partPath(self::E2, $slots2['original'])));
        // E1 never got its media in 73 hours: given up (AppRecoveryTest has the details).
        self::assertSame(1, $result['abandonedEntries'] ?? null);
        self::assertSame(404, $this->phone($token, 'HEAD', '/api/v1/app/uploads/' . $slots['media'])->getStatusCode());
    }

    public function testListAndUnknownEntries(): void
    {
        $token = $this->pairPhone();
        $this->phone($token, 'POST', '/api/v1/app/entries', self::textEntry(self::E1));
        $list = self::json($this->phone($token, 'GET', '/api/v1/app/entries?ids=' . self::E1 . ',' . self::E2));
        self::assertCount(1, $list['items']);
        self::assertError($this->phone($token, 'GET', '/api/v1/app/entries/' . self::E2), 404, 'not_found');
        self::assertError($this->phone($token, 'GET', '/api/v1/app/entries?ids=nope'), 422, 'validation_failed');
        self::assertSame(404, $this->phone($token, 'HEAD', '/api/v1/app/uploads/u_0000000000000000000000')->getStatusCode());
    }

    /** @return array<string, mixed> */
    private function appState(string $token, string $entryId): array
    {
        $response = $this->phone($token, 'GET', '/api/v1/app/entries/' . $entryId);
        self::assertSame(200, $response->getStatusCode(), (string) $response->getBody());

        return self::json($response);
    }

    /**
     * @param array<string, mixed> $state
     * @return array<string, mixed>
     */
    private function slotOf(array $state, string $role): array
    {
        self::assertIsArray($state['uploads']);
        foreach ($state['uploads'] as $slot) {
            if ($slot['role'] === $role) {
                return $slot;
            }
        }
        self::fail("no $role slot");
    }

    private function partPath(string $entryId, string $uploadId): string
    {
        return $this->service(Paths::class)->var(AppInbox::DIR . "/$entryId/$uploadId.part");
    }
}
