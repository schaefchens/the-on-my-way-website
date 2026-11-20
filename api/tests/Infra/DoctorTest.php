<?php

declare(strict_types=1);

namespace Omw\Api\Tests\Infra;

use Omw\Api\Infra\Doctor;
use Omw\Api\Infra\DoctorCheck;
use Omw\Api\Infra\DoctorStatus;
use Omw\Api\Tests\TestCase;

final class DoctorTest extends TestCase
{
    public function testFreshMigratedInstallHasNoFailures(): void
    {
        $config = $this->config();
        $this->migratedDb($config)->close();

        $checks = (new Doctor($config))->run();
        $byName = self::byName($checks);

        self::assertFalse(Doctor::hasFailures($checks), self::describe($checks));
        foreach (['php_version', 'extensions', 'sqlite_version', 'sqlite_json', 'var_dir', 'db_dir', 'journal_mode', 'uploads', 'disk_free', 'database', 'migrations'] as $name) {
            self::assertArrayHasKey($name, $byName, "check $name ran");
        }
        self::assertSame(DoctorStatus::Ok, $byName['journal_mode']->status);
        self::assertSame(DoctorStatus::Ok, $byName['migrations']->status);
        self::assertSame(DoctorStatus::Warn, $byName['admin_user']->status, 'no admin yet');
        self::assertSame(DoctorStatus::Warn, $byName['backend_token']->status, 'no token yet');
        self::assertFileExists($config->varDir . '/.htaccess');
        self::assertSame([], glob(dirname($config->dbPath) . '/.doctor-*') ?: [], 'WAL probe cleaned up');
    }

    public function testWarnsWhenTheDatabaseDoesNotExistYet(): void
    {
        $config = $this->config();
        $checks = (new Doctor($config))->run();

        self::assertSame(DoctorStatus::Warn, self::byName($checks)['database']->status);
        self::assertFileDoesNotExist($config->dbPath, 'doctor must not create the database');
    }

    public function testBinDoctorRunsAndReportsJson(): void
    {
        $this->runBin('migrate.php');
        $result = $this->runBin('doctor.php', ['--json']);

        self::assertSame(0, $result['code'], $result['stdout'] . $result['stderr']);
        $report = json_decode($result['stdout'], true, 8, JSON_THROW_ON_ERROR);
        self::assertIsArray($report);
        self::assertTrue($report['ok']);
        self::assertNotEmpty($report['checks']);

        $human = $this->runBin('doctor.php');
        self::assertSame(0, $human['code']);
        self::assertStringContainsString('[OK  ] php_version', $human['stdout']);
        self::assertStringContainsString('Doctor: OK', $human['stdout']);
    }

    public function testIniBytes(): void
    {
        self::assertSame(2 * 1024 * 1024, Doctor::iniBytes('2M'));
        self::assertSame(1024 * 1024 * 1024, Doctor::iniBytes('1G'));
        self::assertSame(512 * 1024, Doctor::iniBytes('512k'));
        self::assertSame(-1, Doctor::iniBytes('-1'));
        self::assertSame(100, Doctor::iniBytes('100'));
    }

    /**
     * @param list<DoctorCheck> $checks
     * @return array<string, DoctorCheck> first check per name
     */
    private static function byName(array $checks): array
    {
        $out = [];
        foreach ($checks as $check) {
            $out[$check->name] ??= $check;
        }

        return $out;
    }

    /** @param list<DoctorCheck> $checks */
    private static function describe(array $checks): string
    {
        return implode("\n", array_map(static fn (DoctorCheck $c): string => "{$c->status->value} {$c->name}: {$c->message}", $checks));
    }
}
