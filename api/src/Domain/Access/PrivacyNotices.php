<?php

declare(strict_types=1);

namespace Omw\Api\Domain\Access;

use Omw\Api\Config;
use Omw\Api\Domain\Settings;
use Omw\Api\Http\ApiException;
use Omw\Api\Infra\Clock;
use Omw\Api\Infra\Db;
use Omw\Api\Infra\SchemaValidator;
use RuntimeException;
use stdClass;

/**
 * The privacy notice (D11, Q7, spec-wave5 §3.3): one editable draft (seeded lazily from
 * privacy-template.json, {backupDays} = BACKUP_KEEP) and immutable published versions.
 *
 * Publishing needs a complete notice: controller name + e-mail and every text in de AND en
 * (always, D11) and in every further site.locales locale (422 notice_incomplete with the missing
 * paths), and the sha256 of the draft the admin showed (409 conflict otherwise). Hashes are taken
 * over the canonical JSON ({@see canonical()}: object keys sorted, no escaped slashes/unicode).
 */
final class PrivacyNotices
{
    public const TEXT_KEYS = ['title', 'intro', 'collected', 'audience', 'purpose', 'retention', 'rights'];
    public const TEMPLATE = __DIR__ . '/privacy-template.json';

    public function __construct(
        private readonly Db $db,
        private readonly Settings $settings,
        private readonly Config $config,
        private readonly SchemaValidator $schemas,
    ) {
    }

    /** The draft (contract PrivacyNoticeDraft), seeded from the template on first use. */
    public function draft(): stdClass
    {
        $raw = $this->db->scalar('SELECT notice FROM privacy_notice_draft WHERE id = 1');
        if (is_string($raw)) {
            $draft = json_decode($raw, false, 16, JSON_THROW_ON_ERROR);
            if ($draft instanceof stdClass) {
                return $draft;
            }
        }
        $draft = $this->template();
        $this->putDraft($draft);

        return $draft;
    }

    public function putDraft(stdClass $draft): void
    {
        $json = self::canonical($draft);
        $this->db->write(fn (): int => $this->db->exec(
            'INSERT INTO privacy_notice_draft (id, notice, updated_at) VALUES (1, ?, ?)
             ON CONFLICT (id) DO UPDATE SET notice = excluded.notice, updated_at = excluded.updated_at',
            [$json, Clock::nowIso()],
        ));
    }

    /**
     * Locales every published version must cover: de, en and site.locales.
     *
     * @return list<string>
     */
    public function requiredLocales(): array
    {
        $locales = ['de', 'en'];
        $site = $this->settings->get('site.locales');
        foreach (is_array($site) ? $site : [] as $l) {
            if (is_string($l) && !in_array($l, $locales, true)) {
                $locales[] = $l;
            }
        }

        return $locales;
    }

    /**
     * Why the draft cannot be published (missing or invalid paths); [] = publishable.
     *
     * @return list<string>
     */
    public function problems(stdClass $draft): array
    {
        $out = [];
        $c = $draft->controller ?? null;
        $name = $c instanceof stdClass && is_string($c->name ?? null) ? trim($c->name) : '';
        $email = $c instanceof stdClass && is_string($c->email ?? null) ? trim($c->email) : '';
        if ($name === '') {
            $out[] = 'controller.name';
        }
        if ($email === '' || !self::isEmail($email)) {
            $out[] = 'controller.email';
        }
        $texts = $draft->texts ?? null;
        foreach ($this->requiredLocales() as $locale) {
            $t = $texts instanceof stdClass ? ($texts->{$locale} ?? null) : null;
            foreach (self::TEXT_KEYS as $key) {
                $value = $t instanceof stdClass && is_string($t->{$key} ?? null) ? trim($t->{$key}) : '';
                if ($value === '') {
                    $out[] = "texts.$locale.$key";
                }
            }
        }

        return $out;
    }

    /** @throws ApiException 409 conflict (stale draft), 422 notice_incomplete */
    public function publish(string $ifDraftSha256): void
    {
        $this->db->write(function () use ($ifDraftSha256): void {
            $draft = $this->draft();
            if (!hash_equals(hash('sha256', self::canonical($draft)), $ifDraftSha256)) {
                throw ApiException::conflict('The privacy notice draft changed meanwhile. Reload and check it again.');
            }
            $problems = $this->problems($draft);
            if ($problems !== []) {
                throw new ApiException(422, 'notice_incomplete', 'The privacy notice is incomplete.', ['missing' => $problems]);
            }
            $notice = $this->noticeFrom($draft);
            $errors = $this->schemas->errors(SchemaValidator::toJsonValue($notice), 'PrivacyNotice');
            if ($errors !== []) {
                throw new ApiException(422, 'notice_incomplete', 'The privacy notice is not valid.', ['missing' => $errors]);
            }
            $json = self::canonical($notice);
            $version = (int) $this->db->scalar('SELECT COALESCE(MAX(version), 0) FROM privacy_notice_versions') + 1;
            $this->db->exec(
                'INSERT INTO privacy_notice_versions (version, notice, sha256, published_at) VALUES (?, ?, ?, ?)',
                [$version, $json, hash('sha256', $json), Clock::nowIso()],
            );
        });
    }

    /** @return array<string, mixed>|null contract PublicNotice of the newest version */
    public function current(): ?array
    {
        $row = $this->db->one('SELECT version, notice, published_at FROM privacy_notice_versions ORDER BY version DESC LIMIT 1');

        return $row === null ? null : self::publicNotice($row);
    }

    public function currentVersion(): ?int
    {
        $v = $this->db->scalar('SELECT MAX(version) FROM privacy_notice_versions');

        return $v === null ? null : (int) $v;
    }

    /** @return array<string, mixed>|null contract PrivacyNotice of one version */
    public function notice(int $version): ?array
    {
        $raw = $this->db->scalar('SELECT notice FROM privacy_notice_versions WHERE version = ?', [$version]);
        $data = is_string($raw) ? json_decode($raw, true, 16, JSON_THROW_ON_ERROR) : null;

        return is_array($data) ? $data : null;
    }

    /** @return array<string, mixed> contract PrivacyState */
    public function state(): array
    {
        $draft = $this->draft();
        $versions = array_map(static fn (array $r): array => [
            'version' => (int) $r['version'],
            'publishedAt' => (string) $r['published_at'],
            'sha256' => (string) $r['sha256'],
        ], $this->db->all('SELECT version, published_at, sha256 FROM privacy_notice_versions ORDER BY version DESC'));

        return [
            'draft' => $draft,
            'draftSha256' => hash('sha256', self::canonical($draft)),
            'current' => $this->current(),
            'versions' => $versions,
            'problems' => $this->problems($draft),
        ];
    }

    /** Canonical JSON: object keys sorted recursively, lists in order, no escaped slashes or unicode. */
    public static function canonical(mixed $value): string
    {
        return json_encode(self::sortKeys($value), JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    }

    private static function sortKeys(mixed $value): mixed
    {
        if ($value instanceof stdClass) {
            $vars = get_object_vars($value);
            ksort($vars, SORT_STRING);
            $out = new stdClass();
            foreach ($vars as $k => $v) {
                $out->{$k} = self::sortKeys($v);
            }

            return $out;
        }
        if (is_array($value)) {
            if (array_is_list($value)) {
                return array_map(self::sortKeys(...), $value);
            }
            ksort($value, SORT_STRING);
            $out = new stdClass();
            foreach ($value as $k => $v) {
                $out->{$k} = self::sortKeys($v);
            }

            return $out;
        }

        return $value;
    }

    /**
     * @param array<string, mixed> $row
     * @return array<string, mixed>
     */
    private static function publicNotice(array $row): array
    {
        $notice = json_decode((string) $row['notice'], true, 16, JSON_THROW_ON_ERROR);
        if (!is_array($notice)) {
            throw new RuntimeException('Stored privacy notice is not an object.');
        }

        return $notice + ['version' => (int) $row['version'], 'publishedAt' => (string) $row['published_at']];
    }

    /** @return array<string, mixed> contract PrivacyNotice built from a complete draft */
    private function noticeFrom(stdClass $draft): array
    {
        $c = $draft->controller;
        \assert($c instanceof stdClass);
        $controller = ['name' => trim((string) $c->name), 'email' => trim((string) $c->email)];
        if (is_string($c->address ?? null) && trim($c->address) !== '') {
            $controller['address'] = trim($c->address);
        }
        $texts = [];
        $required = $this->requiredLocales();
        $draftTexts = $draft->texts instanceof stdClass ? get_object_vars($draft->texts) : [];
        foreach ($draftTexts as $locale => $t) {
            if (!$t instanceof stdClass) {
                continue;
            }
            $entry = [];
            foreach (self::TEXT_KEYS as $key) {
                $value = is_string($t->{$key} ?? null) ? trim($t->{$key}) : '';
                if ($value !== '') {
                    $entry[$key] = $value;
                }
            }
            // Required locales are complete (checked); further locales only when complete too.
            if (count($entry) === count(self::TEXT_KEYS) || in_array($locale, $required, true)) {
                $texts[(string) $locale] = $entry;
            }
        }
        ksort($texts, SORT_STRING);

        return ['controller' => $controller, 'texts' => $texts];
    }

    private function template(): stdClass
    {
        $raw = file_get_contents(self::TEMPLATE);
        if ($raw === false) {
            throw new RuntimeException('Cannot read privacy-template.json.');
        }
        $raw = str_replace('{backupDays}', (string) $this->config->backupKeep, $raw);
        $data = json_decode($raw, false, 16, JSON_THROW_ON_ERROR);
        if (!$data instanceof stdClass) {
            throw new RuntimeException('privacy-template.json is not an object.');
        }
        unset($data->_comment);

        return $data;
    }

    /** Same pattern as the contract's e-mail format (zod z.email()). */
    private static function isEmail(string $email): bool
    {
        return strlen($email) <= 254
            && preg_match("/^(?:[A-Za-z0-9_'+\\-]+\\.)*[A-Za-z0-9_'+\\-]*[A-Za-z0-9_+-]@(?:[A-Za-z0-9][A-Za-z0-9\\-]*\\.)+[A-Za-z]{2,}$/D", $email) === 1;
    }
}
