<?php

declare(strict_types=1);

namespace Omw\Api\Infra;

use JsonException;
use Opis\JsonSchema\Errors\ErrorFormatter;
use Opis\JsonSchema\Validator;
use RuntimeException;

/**
 * Validates data against the JSON Schemas exported from packages/contracts (api/schemas/*.json,
 * `pnpm schemas`). Data must be decoded JSON with objects as stdClass (json_decode($s, false)):
 * PHP arrays cannot tell {} from [] and are rejected where the contract wants an object.
 */
final class SchemaValidator
{
    private readonly Validator $validator;
    private readonly string $idPrefix;

    public function __construct(private readonly string $schemasDir)
    {
        $index = $schemasDir . '/index.json';
        if (!is_file($index)) {
            throw new RuntimeException("JSON Schemas missing in $schemasDir (run: pnpm schemas).");
        }
        $meta = json_decode((string) file_get_contents($index), false, 8, JSON_THROW_ON_ERROR);
        if (!$meta instanceof \stdClass || !is_string($meta->idPrefix ?? null)) {
            throw new RuntimeException("Invalid $index.");
        }
        $this->idPrefix = $meta->idPrefix;
        $this->validator = new Validator();
        $this->validator->setMaxErrors(5);
        $this->validator->resolver()?->registerPrefix($this->idPrefix, $schemasDir);
    }

    public static function fromRoot(string $apiRootDir): self
    {
        return new self($apiRootDir . '/schemas');
    }

    /** Contract version the exported schemas belong to (api/schemas/index.json). */
    public function contractVersion(): int
    {
        $meta = json_decode((string) file_get_contents($this->schemasDir . '/index.json'), true, 8, JSON_THROW_ON_ERROR);

        return is_array($meta) && is_int($meta['contractVersion'] ?? null) ? $meta['contractVersion'] : 0;
    }

    /**
     * Validation errors of $data against schema $name (e.g. "Post"), optionally at a JSON pointer
     * inside it (e.g. "/properties/publish.mode"); empty list = valid.
     *
     * @return list<string>
     */
    public function errors(mixed $data, string $name, string $pointer = ''): array
    {
        $uri = $this->idPrefix . $name . '.json' . ($pointer === '' ? '' : '#' . $pointer);
        $result = $this->validator->validate($data, $uri);
        $error = $result->error();
        if ($error === null) {
            return [];
        }
        $out = [];
        foreach ((new ErrorFormatter())->format($error, true) as $path => $messages) {
            foreach ((array) $messages as $message) {
                $out[] = ($path === '' ? '/' : (string) $path) . ': ' . (is_string($message) ? $message : json_encode($message));
            }
        }

        return $out === [] ? ['invalid'] : $out;
    }

    /**
     * Converts PHP values to decoded-JSON form (assoc arrays -> objects). Note that an EMPTY PHP
     * array becomes [] (a JSON array); build objects with (object) [] or stdClass instead.
     *
     * @throws JsonException
     */
    public static function toJsonValue(mixed $value): mixed
    {
        return json_decode(json_encode($value, JSON_THROW_ON_ERROR | JSON_PRESERVE_ZERO_FRACTION), false, 64, JSON_THROW_ON_ERROR);
    }
}
