<?php

declare(strict_types=1);

namespace Omw\Api\Http\Admin;

use Omw\Api\Domain\Access\Devices;
use Omw\Api\Domain\Access\Followers;
use Omw\Api\Domain\Access\StoreApplier;
use Omw\Api\Http\Input;
use Omw\Api\Http\Responder;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * Devices (spec-wave5 §3.5), each {} -> AccessActionResult {effect, device, follower}:
 *   POST /admin/devices/{did}/approve  pending → active (409 device_limit at ACCESS_MAX_DEVICES)
 *   POST /admin/devices/{did}/decline  pending → declined
 *   POST /admin/devices/{did}/revoke   active → revoked ("Remove device"; a pending one is declined)
 */
final class DeviceController
{
    public function __construct(
        private readonly Responder $responder,
        private readonly Devices $devices,
        private readonly Followers $followers,
        private readonly StoreApplier $applier,
    ) {
    }

    public function approve(ServerRequestInterface $request, ResponseInterface $response): ResponseInterface
    {
        $did = Input::arg($request, 'did');
        $this->devices->approve($did);

        return $this->result($response, $did, 0);
    }

    public function decline(ServerRequestInterface $request, ResponseInterface $response): ResponseInterface
    {
        $did = Input::arg($request, 'did');
        $this->devices->decline($did);

        return $this->result($response, $did, 0);
    }

    public function revoke(ServerRequestInterface $request, ResponseInterface $response): ResponseInterface
    {
        $did = Input::arg($request, 'did');
        $this->devices->person($did);
        $op = $this->devices->revoke($did, 'owner');
        if ($op > 0) {
            $this->applier->applyNow(8.0);
        }

        return $this->result($response, $did, $op);
    }

    private function result(ResponseInterface $response, string $did, int $op): ResponseInterface
    {
        $device = $this->devices->person($did);

        return $this->responder->json($response, [
            'effect' => $this->applier->effect($op),
            'device' => Devices::dto($device),
            'follower' => $this->followers->dto($this->followers->get((string) $device['follower_id'])),
        ], 'AccessActionResult');
    }
}
