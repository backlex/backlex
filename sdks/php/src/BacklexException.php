<?php

declare(strict_types=1);

namespace Backlex;

/**
 * A non-2xx response from the backlex API (or a transport failure), mirroring the
 * TS SDK's BacklexError. The API returns errors as
 * `{ "error": { "code", "message", "details"? } }`; callers branch on $status /
 * $code rather than parsing strings.
 */
final class BacklexException extends \RuntimeException
{
    public int $status;
    /** @var string Machine-readable error code. Untyped to match Exception::$code. */
    public $code; // phpcs:ignore
    public mixed $details;

    public function __construct(int $status, string $code, string $message, mixed $details = null)
    {
        parent::__construct($message);
        $this->status = $status;
        $this->code = $code;
        $this->details = $details;
    }

    /** Parse the `{ "error": {...} }` envelope from a response body. */
    public static function fromBody(int $status, ?string $body): self
    {
        $code = 'UNKNOWN';
        $message = "HTTP {$status}";
        $details = null;
        if ($body !== null && $body !== '') {
            $env = json_decode($body, true);
            if (is_array($env) && isset($env['error']) && is_array($env['error'])) {
                $err = $env['error'];
                if (!empty($err['code'])) {
                    $code = $err['code'];
                }
                if (!empty($err['message'])) {
                    $message = $err['message'];
                }
                $details = $err['details'] ?? null;
            }
        }
        return new self($status, $code, $message, $details);
    }
}
