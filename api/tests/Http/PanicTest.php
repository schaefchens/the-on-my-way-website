<?php

declare(strict_types=1);

namespace Omw\Api\Tests\Http;

use Omw\Api\Domain\Access\Tokens;

/**
 * The optional panic link (Q6, spec-wave5 §3.3 Lock 3, §3.4): created once in the admin, locks the
 * site when its key matches, always answers {ok: true}, rate limited per IP, removable.
 */
final class PanicTest extends AccessTestCase
{
    public function testPanicLinkLocksAndAlwaysAnswersOk(): void
    {
        $this->bootAccess();
        $this->setUpPerson();
        $created = self::json($this->admin('POST', '/api/v1/admin/access/panic-link', new \stdClass()));
        self::assertStringStartsWith(self::SITE . '/_/panic/#k=', (string) $created['url']);
        $key = substr((string) $created['url'], strlen(self::SITE . '/_/panic/#k='));

        self::assertSame(['ok' => true], self::json($this->pub('panic', ['key' => Tokens::token()])));
        self::assertFalse($this->storeHas('locked'));
        self::assertSame(['ok' => true], self::json($this->pub('panic', ['key' => $key])));
        self::assertTrue($this->storeHas('locked'));
        self::assertSame('panic', $this->appDb()->scalar('SELECT locked_by FROM access_state'));

        self::assertSame(204, $this->admin('DELETE', '/api/v1/admin/access/panic-link')->getStatusCode());
        self::assertNull($this->appDb()->scalar('SELECT panic_hash FROM access_state'));
        for ($i = 0; $i < 10; ++$i) {
            $this->pub('panic', ['key' => Tokens::token()], [], [], '198.51.100.77');
        }
        self::assertError($this->pub('panic', ['key' => $key], [], [], '198.51.100.77'), 429, 'rate_limited');
    }
}
