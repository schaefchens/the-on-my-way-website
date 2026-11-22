<?php

declare(strict_types=1);

// Router for `php -S` in StoreApplierConcurrencyTest: the real app, but its store writer is a
// SlowStoreWriter (OMW_TEST_SLOW_MS per op, applied ops logged to OMW_TEST_OP_LOG). The config is
// built from the process environment only (never from api/.env).

use DI\Container;
use Omw\Api\App;
use Omw\Api\Config;
use Omw\Api\Infra\Store\DirectStoreWriter;
use Omw\Api\Infra\Store\StoreWriter;
use Omw\Api\Infra\Store\StoreWriterFactory;
use Omw\Api\Tests\Support\SlowStoreWriter;

$root = dirname(__DIR__, 2);
require $root . '/vendor/autoload.php';

$env = [];
foreach (Config::knownKeys() as $key) {
    $value = getenv($key);
    if (is_string($value)) {
        $env[$key] = $value;
    }
}
$env['BASE_PATH'] = ''; // php -S sets SCRIPT_NAME to the request path: never auto-detect
$config = Config::fromArray($root, $env);
$container = App::buildContainer($config);
\assert($container instanceof Container);
$container->set(StoreWriterFactory::class, new class ($config) extends StoreWriterFactory {
    public function __construct(private readonly Config $cfg)
    {
        parent::__construct($cfg);
    }

    public function open(): StoreWriter
    {
        return new SlowStoreWriter(
            new DirectStoreWriter($this->cfg->access->storeDir),
            (int) getenv('OMW_TEST_SLOW_MS'),
            (string) getenv('OMW_TEST_OP_LOG'),
        );
    }
});
App::create($config, $_SERVER, $container)->run();
