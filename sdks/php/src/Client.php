<?php

declare(strict_types=1);

namespace Backlex;

/**
 * The official PHP client for the backlex API — a thin wrapper over the same
 * REST + SSE surface the TypeScript SDK (@backlex/client) speaks. Three auth
 * modes: server key, workspace app mode (token capture), or cookie session.
 *
 * Options array: ['api_key' => ?, 'workspace' => ?, 'token' => ?, 'transport' => ?].
 * `transport` is an optional callable(method, url, headers, body): [int, ?string]
 * used for testing in place of curl.
 */
final class Client
{
    private const JSON_FLAGS = JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE;

    private string $url;
    private ?string $apiKey;
    private ?string $tenant;
    private ?string $org;
    private bool $tracing;
    public ?string $workspace;
    public ?string $appToken;
    /** @var callable|null */
    private $transport;

    public Auth $auth;
    public Storage $storage;

    public function __construct(string $url, array $opts = [])
    {
        $this->url = rtrim($url, '/');
        $this->apiKey = $opts['api_key'] ?? null;
        $this->tenant = $opts['tenant'] ?? null;
        $this->workspace = $opts['workspace'] ?? null;
        $this->appToken = $opts['token'] ?? null;
        $this->org = $opts['org'] ?? null;
        $this->tracing = $opts['tracing'] ?? true;
        $this->transport = $opts['transport'] ?? null;
        $this->auth = new Auth($this);
        $this->storage = new Storage($this);
    }

    public function from(string $slug): Collection
    {
        return new Collection($this, $slug);
    }

    /** Subscribe to a realtime channel (blocking — see {@see Realtime}). */
    public function subscribe(string $channel, callable $onEvent, ?callable $onError = null): void
    {
        (new Realtime($this))->listen($channel, $onEvent, $onError);
    }

    public function getBaseUrl(): string
    {
        return $this->url;
    }

    /**
     * Act inside a specific organization (slug or id) from here on, so
     * `$org.id` in permission rules resolves without threading it through
     * every call. Only meaningful for app-plane sessions.
     */
    public function setOrg(?string $org): void
    {
        $this->org = $org;
    }

    /**
     * A W3C traceparent: 00-<32-hex trace id>-<16-hex span id>-01. Mirrors
     * packages/client/src/trace.ts, which is what the API parses. Fresh per
     * request — a span id reused across calls collapses them into one span.
     */
    public static function makeTraceparent(): string
    {
        return '00-' . bin2hex(random_bytes(16)) . '-' . bin2hex(random_bytes(8)) . '-01';
    }

    /** @return list<string> */
    public function authHeaders(): array
    {
        $headers = [];
        if ($this->apiKey !== null && $this->apiKey !== '') {
            $headers[] = 'Authorization: Bearer ' . $this->apiKey;
        } elseif ($this->appToken !== null && $this->appToken !== '') {
            $headers[] = 'Authorization: Bearer ' . $this->appToken;
        }
        if ($this->tenant !== null && $this->tenant !== '') {
            $headers[] = 'X-Backlex-Tenant: ' . $this->tenant;
        }
        if ($this->org !== null && $this->org !== '') {
            $headers[] = 'X-Backlex-Org: ' . $this->org;
        }
        // Without this a call never appears in the admin Traces panel and
        // cannot be stitched to the server spans it triggers.
        if ($this->tracing) {
            $headers[] = 'traceparent: ' . self::makeTraceparent();
        }
        return $headers;
    }

    /** Raw escape hatch — issues a JSON request with auth headers applied. */
    public function request(string $method, string $path, mixed $body = null): mixed
    {
        $headers = array_merge(['Content-Type: application/json'], $this->authHeaders());
        $payload = $body === null ? null : json_encode($body, self::JSON_FLAGS);
        [$status, $respBody] = $this->send($method, $this->url . $path, $headers, $payload);
        if ($status < 200 || $status >= 300) {
            throw BacklexException::fromBody($status, $respBody);
        }
        if ($status === 204 || $respBody === null || $respBody === '') {
            return null;
        }
        return json_decode($respBody, true);
    }

    /**
     * Raw-body request (e.g. storage). Returns [status, body].
     * @return array{0:int,1:?string}
     */
    public function sendRaw(string $method, string $path, ?string $body, ?string $contentType): array
    {
        $headers = $this->authHeaders();
        if ($contentType !== null) {
            $headers[] = 'Content-Type: ' . $contentType;
        }
        [$status, $respBody] = $this->send($method, $this->url . $path, $headers, $body);
        if ($status < 200 || $status >= 300) {
            throw BacklexException::fromBody($status, $respBody);
        }
        return [$status, $respBody];
    }

    /** @return array{0:int,1:?string} */
    private function send(string $method, string $url, array $headers, ?string $body): array
    {
        if ($this->transport !== null) {
            return ($this->transport)($method, $url, $headers, $body);
        }

        $ch = curl_init($url);
        curl_setopt_array($ch, [
            CURLOPT_CUSTOMREQUEST => $method,
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_HTTPHEADER => $headers,
            CURLOPT_FOLLOWLOCATION => true,
        ]);
        if ($body !== null) {
            curl_setopt($ch, CURLOPT_POSTFIELDS, $body);
        }
        $resp = curl_exec($ch);
        if ($resp === false) {
            $err = curl_error($ch);
            curl_close($ch);
            throw new BacklexException(0, 'NETWORK', $err);
        }
        $status = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
        curl_close($ch);
        return [$status, is_string($resp) ? $resp : null];
    }

    /**
     * Serialize a ListQuery array into a URL query string (mirrors buildSearch in
     * index.ts). The filter is compact JSON, percent-encoded exactly once.
     */
    public static function buildSearch(?array $q): string
    {
        if ($q === null) {
            return '';
        }
        $parts = [];
        if (!empty($q['filter'])) {
            $parts[] = 'filter=' . rawurlencode(json_encode($q['filter'], self::JSON_FLAGS));
        }
        if (!empty($q['sort'])) {
            $parts[] = 'sort=' . rawurlencode(implode(',', $q['sort']));
        }
        if (!empty($q['fields'])) {
            $parts[] = 'fields=' . rawurlencode(implode(',', $q['fields']));
        }
        if (!empty($q['expand'])) {
            $parts[] = 'expand=' . rawurlencode(implode(',', $q['expand']));
        }
        if (($q['limit'] ?? null) !== null) {
            $parts[] = 'limit=' . $q['limit'];
        }
        if (($q['offset'] ?? null) !== null) {
            $parts[] = 'offset=' . $q['offset'];
        }
        if (!empty($q['meta'])) {
            $parts[] = 'meta=' . rawurlencode($q['meta']);
        }
        if (!empty($q['locale'])) {
            $parts[] = 'locale=' . rawurlencode($q['locale']);
        }
        if (!empty($q['q'])) {
            $parts[] = 'q=' . rawurlencode($q['q']);
        }
        return empty($parts) ? '' : '?' . implode('&', $parts);
    }
}
