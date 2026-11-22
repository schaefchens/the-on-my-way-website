<?php

declare(strict_types=1);

namespace Omw\Api;

use DI\ContainerBuilder;
use Omw\Api\Domain\Access\GateProbe;
use Omw\Api\Domain\Access\OwnerNotices;
use Omw\Api\Domain\Access\StoreApplier;
use Omw\Api\Domain\Alerts\AlertEngine;
use Omw\Api\Domain\Alerts\ChannelNotifier;
use Omw\Api\Domain\Alerts\Notifier;
use Omw\Api\Domain\Auth\ApiTokens;
use Omw\Api\Domain\Auth\LoginThrottle;
use Omw\Api\Domain\Auth\Sessions;
use Omw\Api\Domain\ChangeLog;
use Omw\Api\Http\JsonErrorHandler;
use Omw\Api\Http\Public\PublicSupport;
use Omw\Api\Http\Middleware\AutoSetup;
use Omw\Api\Http\Middleware\SecurityHeaders;
use Omw\Api\Http\Routes;
use Omw\Api\Infra\AutoMigrator;
use Omw\Api\Infra\Bootstrapper;
use Omw\Api\Infra\CronRunner;
use Omw\Api\Infra\Db;
use Omw\Api\Infra\LoggerFactory;
use Omw\Api\Infra\Migrator;
use Omw\Api\Infra\Paths;
use Omw\Api\Infra\SchemaValidator;
use Psr\Container\ContainerInterface;
use Psr\Http\Message\ResponseFactoryInterface;
use Psr\Log\LoggerInterface;
use Slim\App as SlimApp;
use Slim\Factory\AppFactory;
use Slim\Middleware\MethodOverrideMiddleware;
use Slim\Psr7\Factory\ResponseFactory;

/**
 * Builds the Slim application: PHP-DI container, middleware stack, JSON errors and routes.
 */
final class App
{
    /** API release version, reported by GET /api/v1/health. */
    public const VERSION = '1.0.0';

    /** Contract version of packages/contracts this API speaks (contractVersion in sync bodies). */
    public const CONTRACT_VERSION = 1;

    /**
     * Front-controller entry: config from the environment (+ api/.env).
     *
     * @return SlimApp<ContainerInterface>
     */
    public static function fromEnvironment(string $rootDir): SlimApp
    {
        return self::create(Config::fromEnvironment($rootDir), $_SERVER);
    }

    /**
     * @param array<string, mixed> $server server params used to auto-detect the base path
     *                                     when BASE_PATH is not configured
     * @return SlimApp<ContainerInterface>
     */
    public static function create(Config $config, array $server = [], ?ContainerInterface $container = null): SlimApp
    {
        $container ??= self::buildContainer($config);
        /** @var SlimApp<ContainerInterface> $app */
        $app = AppFactory::createFromContainer($container);
        $app->setBasePath($config->basePath ?? self::detectBasePath($server));

        // Slim runs middleware last-added-first. Effective order for a request:
        //   SecurityHeaders -> ErrorMiddleware -> AutoSetup -> BodyParsing -> MethodOverride -> Routing -> route
        // (MethodOverride needs the parsed body for "_METHOD"; Routing must see the overridden method;
        // AutoSetup applies pending migrations / var/bootstrap.json before anything touches the DB;
        // SecurityHeaders also decorates error responses.)
        $app->addRoutingMiddleware();
        $app->add(new MethodOverrideMiddleware());
        $app->addBodyParsingMiddleware([
            // JSON objects stay objects (stdClass): opis/json-schema needs them, and only then can
            // "{}" be told apart from "[]". Invalid JSON leaves the parsed body null (handlers: 400).
            'application/json' => static fn (string $input): mixed => self::decodeJsonBody($input),
            // JSON API: forms and XML are never parsed (no "_METHOD" override from a cross-site
            // form post; method override only via the X-Http-Method-Override header).
            'application/x-www-form-urlencoded' => static fn (): ?array => null,
            'application/xml' => static fn (): ?array => null,
            'text/xml' => static fn (): ?array => null,
        ]);

        $app->add(AutoSetup::class);

        $logger = $container->get(LoggerInterface::class);
        $errorMiddleware = $app->addErrorMiddleware($config->debug, true, $config->debug || !$config->isProduction(), $logger);
        $errorMiddleware->setDefaultErrorHandler($container->get(JsonErrorHandler::class));
        $app->add(SecurityHeaders::class);

        Routes::register($app);

        return $app;
    }

    /**
     * Parsed JSON request body: objects as stdClass, null for invalid JSON or scalars.
     *
     * @return object|list<mixed>|null
     */
    public static function decodeJsonBody(string $input): object|array|null
    {
        // Body parsing runs before routing and authentication: never spend memory and CPU on
        // decoding oversized bodies (Http\Input::body() answers 413 for them on JSON routes).
        if (strlen($input) > Http\Input::MAX_JSON_BYTES) {
            return null;
        }
        try {
            $decoded = json_decode($input, false, 64, JSON_THROW_ON_ERROR);
        } catch (\JsonException) {
            return null;
        }

        if (is_object($decoded)) {
            return $decoded;
        }

        return is_array($decoded) && array_is_list($decoded) ? $decoded : null;
    }

    /**
     * @param string $logChannel "api" for web requests; CLI entry points pass their own channel
     *                           (e.g. "cron"), which logs to a sibling file (LoggerFactory)
     */
    public static function buildContainer(Config $config, string $logChannel = 'api'): ContainerInterface
    {
        $builder = new ContainerBuilder();
        $builder->useAutowiring(true);
        $builder->addDefinitions([
            Config::class => $config,
            Paths::class => static fn (Config $c): Paths => new Paths($c),
            LoggerInterface::class => static fn (Config $c): LoggerInterface => LoggerFactory::create($c, $logChannel),
            Db::class => static fn (Config $c, LoggerInterface $log): Db => Db::fromConfig($c, $log),
            Migrator::class => static fn (Db $db, Config $c): Migrator => new Migrator($db, $c->migrationsDir()),
            SchemaValidator::class => static fn (Config $c): SchemaValidator => SchemaValidator::fromRoot($c->rootDir),
            ChangeLog::class => static fn (Db $db, SchemaValidator $v): ChangeLog => new ChangeLog($db, $v),
            ResponseFactoryInterface::class => static fn (): ResponseFactoryInterface => new ResponseFactory(),
            JsonErrorHandler::class => static fn (ResponseFactoryInterface $rf, LoggerInterface $log): JsonErrorHandler => new JsonErrorHandler($rf, $log),
            Sessions::class => static fn (Db $db, ApiTokens $t, LoginThrottle $l, Config $c, LoggerInterface $log): Sessions => new Sessions($db, $t, $l, $c->sessionDays, $log),
            Bootstrapper::class => static fn (Db $db, Paths $p, LoggerInterface $log): Bootstrapper => new Bootstrapper($db, $p, $log),
            AutoMigrator::class => static fn (Config $c, Paths $p, Migrator $m, Bootstrapper $b, LoggerInterface $log): AutoMigrator => new AutoMigrator($c, $p, $m, $b, $log),
            Notifier::class => \DI\get(ChannelNotifier::class),
            // Autowiring skips optional constructor parameters, so the (optional) loggers of these
            // must be wired explicitly; otherwise cron would never log alert delivery errors.
            ChannelNotifier::class => \DI\autowire()->constructorParameter('logger', \DI\get(LoggerInterface::class)),
            AlertEngine::class => \DI\autowire()->constructorParameter('logger', \DI\get(LoggerInterface::class)),
            CronRunner::class => \DI\autowire()->constructorParameter('logger', \DI\get(LoggerInterface::class)),
            StoreApplier::class => \DI\autowire()->constructorParameter('logger', \DI\get(LoggerInterface::class)),
            OwnerNotices::class => \DI\autowire()->constructorParameter('logger', \DI\get(LoggerInterface::class)),
            GateProbe::class => \DI\autowire()->constructorParameter('logger', \DI\get(LoggerInterface::class)),
            PublicSupport::class => \DI\autowire()->constructorParameter('logger', \DI\get(LoggerInterface::class)),
        ]);

        return $builder->build();
    }

    /**
     * Base path when the app is not at the web root, e.g. SCRIPT_NAME "/omw/public/index.php" and
     * REQUEST_URI "/omw/public/api/v1/health" -> "/omw/public". Set BASE_PATH to override.
     *
     * @param array<string, mixed> $server
     */
    public static function detectBasePath(array $server): string
    {
        $script = is_string($server['SCRIPT_NAME'] ?? null) ? $server['SCRIPT_NAME'] : '';
        $uri = is_string($server['REQUEST_URI'] ?? null) ? $server['REQUEST_URI'] : '';
        $dir = rtrim(str_replace('\\', '/', dirname($script)), '/');
        if ($dir === '' || $dir === '.') {
            return '';
        }

        $path = parse_url($uri, PHP_URL_PATH);
        $path = is_string($path) ? $path : '';

        return ($path === $dir || str_starts_with($path, $dir . '/')) ? $dir : '';
    }
}
