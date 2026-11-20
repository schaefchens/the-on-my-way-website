<?php

declare(strict_types=1);

namespace Omw\Api\Infra;

enum DoctorStatus: string
{
    case Ok = 'ok';
    case Warn = 'warn';
    case Fail = 'fail';
}
