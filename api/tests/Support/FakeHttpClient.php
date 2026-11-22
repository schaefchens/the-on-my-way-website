<?php

declare(strict_types=1);

namespace Omw\Api\Tests\Support;

use Omw\Api\Infra\HttpClient;

/** Records outgoing requests and answers them with a callback (no network). */
final class FakeHttpClient extends HttpClient
{
    /** @var list<array{method: string, url: string, headers: array<string, string>}> */
    public array $requests = [];

    /** @param callable(string, string, array<string, string>): array{status: int, body: string} $answer */
    public function __construct(private $answer)
    {
        parent::__construct(false);
    }

    public function request(string $method, string $url, array $headers = [], ?string $body = null, float $timeout = 10.0, ?array $pinnedIps = null): array
    {
        $this->requests[] = ['method' => $method, 'url' => $url, 'headers' => $headers];

        return ($this->answer)($method, $url, $headers);
    }
}
