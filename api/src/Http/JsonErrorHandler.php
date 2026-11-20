<?php

declare(strict_types=1);

namespace Omw\Api\Http;

use Psr\Http\Message\ResponseFactoryInterface;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;
use Psr\Log\LoggerInterface;
use Slim\Exception\HttpException;
use Slim\Exception\HttpMethodNotAllowedException;
use Slim\Interfaces\ErrorHandlerInterface;
use Throwable;

/**
 * Renders every uncaught exception as the contract's ApiError body:
 * {"error": {"code": "<snake_case>", "message": "<human readable>", "details"?: ...}}
 *
 * Internal errors never leak their message unless APP_DEBUG is on.
 */
final class JsonErrorHandler implements ErrorHandlerInterface
{
    private const HTTP_CODES = [
        400 => 'bad_request',
        401 => 'unauthorized',
        403 => 'forbidden',
        404 => 'not_found',
        405 => 'method_not_allowed',
        409 => 'conflict',
        410 => 'gone',
        413 => 'payload_too_large',
        415 => 'unsupported_media_type',
        422 => 'validation_failed',
        429 => 'rate_limited',
        500 => 'internal',
        501 => 'not_implemented',
        503 => 'unavailable',
    ];

    public function __construct(
        private readonly ResponseFactoryInterface $responseFactory,
        private readonly ?LoggerInterface $logger = null,
    ) {
    }

    public function __invoke(
        ServerRequestInterface $request,
        Throwable $exception,
        bool $displayErrorDetails,
        bool $logErrors,
        bool $logErrorDetails,
    ): ResponseInterface {
        $details = null;
        if ($exception instanceof ApiException) {
            $status = $exception->status;
            $code = $exception->errorCode;
            $message = $exception->getMessage();
            $details = $exception->details;
        } elseif ($exception instanceof HttpException) {
            $status = $exception->getCode();
            $code = self::HTTP_CODES[$status] ?? 'http_' . $status;
            $message = $exception->getMessage();
        } else {
            $status = 500;
            $code = 'internal';
            $message = 'Internal server error.';
        }
        if ($status < 400 || $status > 599) {
            $status = 500;
            $code = 'internal';
        }

        if ($logErrors && $status >= 500 && $status !== 501) {
            $this->logger?->error('{method} {path} failed: {exception_message}', [
                'method' => $request->getMethod(),
                'path' => $request->getUri()->getPath(),
                'exception_message' => $exception->getMessage(),
                'exception' => $logErrorDetails ? $exception : $exception::class,
            ]);
        }

        $error = ['code' => $code, 'message' => $message];
        if ($details !== null) {
            $error['details'] = $details;
        }
        if ($displayErrorDetails && $status >= 500 && $status !== 501) {
            $error['details'] = [
                'type' => $exception::class,
                'message' => $exception->getMessage(),
                'file' => $exception->getFile(),
                'line' => $exception->getLine(),
                'trace' => explode("\n", $exception->getTraceAsString()),
            ];
        }

        $response = Json::respond($this->responseFactory->createResponse(), ['error' => $error], $status);
        if ($exception instanceof HttpMethodNotAllowedException) {
            $response = $response->withHeader('Allow', implode(', ', $exception->getAllowedMethods()));
        }
        if ($exception instanceof ApiException) {
            foreach ($exception->headers as $name => $value) {
                $response = $response->withAddedHeader($name, $value);
            }
            if ($status === 429 && is_array($details) && is_int($details['retryAfter'] ?? null) && !$response->hasHeader('Retry-After')) {
                $response = $response->withHeader('Retry-After', (string) $details['retryAfter']);
            }
        }

        return $response;
    }
}
