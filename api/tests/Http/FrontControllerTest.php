<?php

declare(strict_types=1);

namespace Omw\Api\Tests\Http;

use Omw\Api\Tests\TestCase;
use RuntimeException;

/**
 * public/index.php under PHP's built-in server with expose_php=On (review L1-14): no response
 * of the front controller carries "X-Powered-By". A control server (a bare script) shows that
 * this PHP build would otherwise send it.
 */
final class FrontControllerTest extends TestCase
{
    /** @var list<resource> */
    private array $procs = [];

    protected function tearDown(): void
    {
        foreach ($this->procs as $proc) {
            proc_terminate($proc);
            proc_close($proc);
        }
        $this->procs = [];
        parent::tearDown();
    }

    public function testNoXPoweredByHeader(): void
    {
        $control = $this->tmpDir() . '/control.php';
        file_put_contents($control, "<?php echo 'ok';\n");
        $controlHeaders = $this->get($this->serve($control, $this->tmpDir()), '/');
        if (!preg_grep('/^X-Powered-By:/i', $controlHeaders)) {
            self::markTestSkipped('expose_php has no effect in this PHP build');
        }

        $root = self::rootDir();
        $port = $this->serve($root . '/public/index.php', $root . '/public');
        foreach (['/api/v1/health', '/api/v1/nope', '/admin/assets/missing.js'] as $path) {
            $headers = $this->get($port, $path);
            self::assertMatchesRegularExpression('#^HTTP/1\.[01] (200|404)#', $headers[0] ?? '', $path);
            self::assertSame([], preg_grep('/^X-Powered-By:/i', $headers), $path . ': ' . implode(' | ', $headers));
        }
    }

    /** Starts `php -S` on a free loopback port and waits until it accepts connections. */
    private function serve(string $router, string $docroot): int
    {
        $probe = stream_socket_server('tcp://127.0.0.1:0');
        if ($probe === false) {
            throw new RuntimeException('no free port');
        }
        $port = (int) explode(':', (string) stream_socket_get_name($probe, false))[1];
        fclose($probe);

        $env = array_merge(getenv(), self::testEnv($this->tmpDir()), ['APP_ENV' => 'production']);
        $cmd = [PHP_BINARY, '-d', 'expose_php=On', '-S', "127.0.0.1:$port", '-t', $docroot, $router];
        $proc = proc_open($cmd, [0 => ['file', '/dev/null', 'r'], 1 => ['file', '/dev/null', 'w'], 2 => ['file', '/dev/null', 'w']], $pipes, self::rootDir(), $env);
        if (!is_resource($proc)) {
            throw new RuntimeException('cannot start php -S');
        }
        $this->procs[] = $proc;
        for ($i = 0; $i < 100; ++$i) {
            $socket = @stream_socket_client("tcp://127.0.0.1:$port", $errno, $errstr, 0.2);
            if ($socket !== false) {
                fclose($socket);

                return $port;
            }
            usleep(50_000);
        }
        throw new RuntimeException("php -S did not come up on $port");
    }

    /** @return list<string> status line + header lines */
    private function get(int $port, string $path): array
    {
        $socket = stream_socket_client("tcp://127.0.0.1:$port", $errno, $errstr, 5.0);
        if ($socket === false) {
            throw new RuntimeException("connect to 127.0.0.1:$port failed: $errno");
        }
        stream_set_timeout($socket, 10);
        fwrite($socket, "GET $path HTTP/1.0\r\nHost: 127.0.0.1:$port\r\nConnection: close\r\n\r\n");
        $raw = (string) stream_get_contents($socket);
        fclose($socket);

        return array_values(array_filter(explode("\r\n", explode("\r\n\r\n", $raw, 2)[0]), static fn (string $l): bool => $l !== ''));
    }
}
