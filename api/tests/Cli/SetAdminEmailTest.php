<?php

declare(strict_types=1);

namespace Omw\Api\Tests\Cli;

use Omw\Api\Domain\Auth\ApiTokens;
use Omw\Api\Domain\Auth\LoginThrottle;
use Omw\Api\Domain\Auth\Users;
use Omw\Api\Tests\TestCase;

/**
 * bin/set-admin-email.php (review L1-07): validated, unique, sessions and app tokens kept.
 */
final class SetAdminEmailTest extends TestCase
{
    public function testChangesTheOnlyUsersEmailAndKeepsSessions(): void
    {
        $this->runBin('migrate.php');
        $db = $this->migratedDb($this->config());
        $users = new Users($db);
        $id = $users->create('owner@on-my-way.invalid', password_hash('correct horse battery', PASSWORD_BCRYPT, ['cost' => 4]));
        $session = (new ApiTokens($db))->create('session', 'browser', null, $id);
        (new LoginThrottle($db))->record('198.51.100.20', 'owner@on-my-way.invalid', true);
        $db->close();

        $result = $this->runBin('set-admin-email.php', ['--to=Hidden.Owner@Example.org']);
        self::assertSame(0, $result['code'], $result['stderr']);
        self::assertStringContainsString('now logs in as hidden.owner@example.org', $result['stdout']);

        self::assertNull($users->findByEmail('owner@on-my-way.invalid'));
        self::assertSame($id, $users->findByEmail('hidden.owner@example.org')['id'] ?? null);
        self::assertNotNull((new ApiTokens($db))->authenticate($session['token']), 'the session survives');
        self::assertTrue((new LoginThrottle($db))->isKnownDevice('198.51.100.20', 'hidden.owner@example.org'));

        $again = $this->runBin('set-admin-email.php', ['--from=hidden.owner@example.org', '--to=HIDDEN.owner@example.org']);
        self::assertSame(0, $again['code'], $again['stderr']);
        self::assertStringContainsString('nothing changed', $again['stdout']);
    }

    public function testRefusesInvalidUnknownAndTakenAddresses(): void
    {
        $this->runBin('migrate.php');
        self::assertSame(1, $this->runBin('set-admin-email.php', ['--to=new@example.org'])['code'], 'no user yet');

        $db = $this->migratedDb($this->config());
        $users = new Users($db);
        $users->create('owner@example.org', 'x');
        $db->close();

        $cases = [
            [['--to=not-an-email'], 1, 'not a valid e-mail'],
            [[], 2, 'Missing --to'],
            [['--to='], 2, 'Missing --to'],
            [['--from=nobody@example.org', '--to=new@example.org'], 1, 'No user with the e-mail nobody@example.org'],
            [['--bogus'], 1, 'Unknown option'],
            [['new@example.org'], 2, 'Unexpected argument'],
        ];
        foreach ($cases as [$args, $code, $message]) {
            $result = $this->runBin('set-admin-email.php', $args);
            self::assertSame($code, $result['code'], implode(' ', $args) . ': ' . $result['stderr']);
            self::assertStringContainsString($message, $result['stderr']);
        }

        $users->create('second@example.org', 'x');
        $db->close();
        $ambiguous = $this->runBin('set-admin-email.php', ['--to=new@example.org']);
        self::assertSame(1, $ambiguous['code']);
        self::assertStringContainsString('more than one user', $ambiguous['stderr']);
        $taken = $this->runBin('set-admin-email.php', ['--from=owner@example.org', '--to=Second@example.org']);
        self::assertSame(1, $taken['code']);
        self::assertStringContainsString('Another user already has', $taken['stderr']);
        self::assertNotNull($users->findByEmail('owner@example.org'), 'unchanged');
    }
}
