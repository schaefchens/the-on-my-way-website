<?php

declare(strict_types=1);

namespace Omw\Api\Tests\Domain;

use InvalidArgumentException;
use Omw\Api\Domain\Auth\ApiTokens;
use Omw\Api\Domain\Auth\Csrf;
use Omw\Api\Domain\Auth\Passwords;
use Omw\Api\Domain\Auth\Users;
use Omw\Api\Infra\SchemaValidator;
use Omw\Api\Tests\TestCase;
use PDOException;

final class AuthTest extends TestCase
{
    public function testPasswordHashing(): void
    {
        $hash = Passwords::hash('correct horse battery');

        self::assertTrue(Passwords::verify('correct horse battery', $hash));
        self::assertFalse(Passwords::verify('wrong horse battery', $hash));
        self::assertFalse(Passwords::needsRehash($hash));
        self::assertStringStartsWith(Passwords::argon2idAvailable() ? '$argon2id$' : '$2y$', $hash);
        self::assertNotNull(Passwords::weakness('short'));
        self::assertNull(Passwords::weakness('long enough password'));
    }

    public function testUsersAreUniqueByCaseInsensitiveEmail(): void
    {
        $users = new Users($this->migratedDb($this->config()));
        $id = $users->create('Owner@Example.com', Passwords::hash('correct horse battery'));

        self::assertSame(['id' => $id, 'email' => 'owner@example.com', 'role' => 'owner'], $users->findByEmail('OWNER@example.com'));
        $this->expectException(PDOException::class);
        $users->create('owner@example.COM', 'x');
    }

    public function testInvalidEmailIsRejected(): void
    {
        $this->expectException(InvalidArgumentException::class);
        Users::normalizeEmail('not-an-email');
    }

    public function testTokensAreStoredOnlyAsSha256(): void
    {
        $db = $this->migratedDb($this->config());
        $tokens = new ApiTokens($db);

        $created = $tokens->create('backend', 'home-mac');

        self::assertTrue(ApiTokens::looksLikeToken($created['token']));
        $row = $db->one('SELECT * FROM api_tokens WHERE id = ?', [$created['id']]);
        self::assertNotNull($row);
        self::assertSame(hash('sha256', $created['token']), $row['token_hash']);
        self::assertSame('["backend"]', $row['scopes']);
        self::assertStringNotContainsString(substr($created['token'], 4), implode('|', array_map('strval', $row)));
        self::assertSame(1, $tokens->countActive('backend'));

        self::assertTrue($tokens->revoke($created['id']));
        self::assertFalse($tokens->revoke($created['id']));
        self::assertSame(0, $tokens->countActive('backend'));
        self::assertSame([], $tokens->list());
        self::assertCount(1, $tokens->list(includeRevoked: true));
    }

    public function testAppTokensNeedAUserAndKnownScopes(): void
    {
        $db = $this->migratedDb($this->config());
        $tokens = new ApiTokens($db);
        $userId = (new Users($db))->create('owner@example.com', Passwords::hash('correct horse battery'));

        $app = $tokens->create('app', 'iphone', null, $userId);
        self::assertSame(['admin'], $tokens->list()[0]['scopes']);
        self::assertNotSame('', $app['token']);

        try {
            $tokens->create('app', 'no user');
            self::fail('app token without user accepted');
        } catch (InvalidArgumentException) {
        }

        try {
            $tokens->create('backend', 'x', ['admin']);
            self::fail('backend token with admin scope accepted');
        } catch (InvalidArgumentException) {
        }

        $this->expectException(InvalidArgumentException::class);
        $tokens->create('backend', 'x', ['root']);
    }

    public function testTokenListUsesTheContractShapeAndHidesSessions(): void
    {
        $db = $this->migratedDb($this->config());
        $tokens = new ApiTokens($db);
        $userId = (new Users($db))->create('owner@example.com', Passwords::hash('correct horse battery'));
        $tokens->create('session', 'browser', null, $userId);
        $tokens->create('backend', 'home-mac');

        $list = $tokens->list();
        self::assertCount(1, $list);
        $validator = SchemaValidator::fromRoot(self::rootDir());
        self::assertSame([], $validator->errors(SchemaValidator::toJsonValue(['items' => $list]), 'TokenListResponse'));
    }

    public function testCsrfTokensAreDerivedFromTheSession(): void
    {
        $session = ApiTokens::generate();
        $csrf = Csrf::tokenFor($session);

        self::assertSame($csrf, Csrf::tokenFor($session), 'stable for the whole session (every tab)');
        self::assertNotSame($csrf, Csrf::tokenFor(ApiTokens::generate()));
        self::assertMatchesRegularExpression('/^[A-Za-z0-9_-]{43}$/', $csrf);
        self::assertStringNotContainsString(substr($session, 4, 12), $csrf);
        self::assertTrue(Csrf::verify($session, $csrf));
        self::assertFalse(Csrf::verify($session, null));
        self::assertFalse(Csrf::verify($session, ''));
        self::assertFalse(Csrf::verify($session, $csrf . 'x'));
    }
}
