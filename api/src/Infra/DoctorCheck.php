<?php

declare(strict_types=1);

namespace Omw\Api\Infra;

/** One result line of {@see Doctor}. */
final class DoctorCheck
{
    public function __construct(
        public readonly string $name,
        public readonly DoctorStatus $status,
        public readonly string $message,
        public readonly ?string $hint = null,
    ) {
    }

    public static function ok(string $name, string $message): self
    {
        return new self($name, DoctorStatus::Ok, $message);
    }

    public static function warn(string $name, string $message, ?string $hint = null): self
    {
        return new self($name, DoctorStatus::Warn, $message, $hint);
    }

    public static function fail(string $name, string $message, ?string $hint = null): self
    {
        return new self($name, DoctorStatus::Fail, $message, $hint);
    }

    /** @return array{name: string, status: string, message: string, hint: string|null} */
    public function toArray(): array
    {
        return ['name' => $this->name, 'status' => $this->status->value, 'message' => $this->message, 'hint' => $this->hint];
    }
}
