<?php

declare(strict_types=1);

namespace Omw\Api\Infra;

use Monolog\Handler\RotatingFileHandler;
use Monolog\Handler\StreamHandler;
use Monolog\Level;
use Monolog\Logger;
use Monolog\Processor\PsrLogMessageProcessor;
use Omw\Api\Config;

final class LoggerFactory
{
    /** Daily log files kept when logging to a file (shared hosts rarely run logrotate for us). */
    public const KEEP_DAYS = 14;

    /**
     * Channel "api" (web requests) logs to LOG_PATH; other channels (cli, cron) to a sibling file
     * named after the channel, so a cron job running as another user than the web server can
     * never make the web log unwritable.
     */
    public static function create(Config $config, string $channel = 'api'): Logger
    {
        $level = self::level($config->logLevel);
        if (str_starts_with($config->logPath, 'php://')) {
            $handler = new StreamHandler($config->logPath, $level);
        } else {
            $path = $channel === 'api' ? $config->logPath : dirname($config->logPath) . '/' . $channel . '.log';
            $handler = new RotatingFileHandler($path, self::KEEP_DAYS, $level);
        }

        return (new Logger($channel))
            ->pushHandler($handler)
            ->pushProcessor(new PsrLogMessageProcessor(null, true));
    }

    private static function level(string $name): Level
    {
        return match ($name) {
            'debug' => Level::Debug,
            'notice' => Level::Notice,
            'warning' => Level::Warning,
            'error' => Level::Error,
            'critical' => Level::Critical,
            'alert' => Level::Alert,
            'emergency' => Level::Emergency,
            default => Level::Info,
        };
    }
}
