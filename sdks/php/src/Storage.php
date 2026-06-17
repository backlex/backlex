<?php

declare(strict_types=1);

namespace Backlex;

/** File operations against /api/storage. */
final class Storage
{
    public function __construct(private Client $client)
    {
    }

    /** List stored objects, optionally filtered by key prefix. */
    public function list(?string $prefix = null): array
    {
        $path = '/api/storage';
        if ($prefix !== null && $prefix !== '') {
            $path .= '?prefix=' . rawurlencode($prefix);
        }
        return $this->client->request('GET', $path)['data'];
    }

    /** Upload bytes under $key. Pass contentType/folderId null to omit them. */
    public function put(string $key, string $body, ?string $contentType = null, ?string $folderId = null): array
    {
        $path = '/api/storage/' . rawurlencode($key);
        if ($folderId !== null && $folderId !== '') {
            $path .= '?folderId=' . rawurlencode($folderId);
        }
        [, $resp] = $this->client->sendRaw('PUT', $path, $body, $contentType);
        return ($resp === null || $resp === '') ? [] : json_decode($resp, true);
    }

    /** Fetch the raw bytes for $key. */
    public function download(string $key): string
    {
        [, $resp] = $this->client->sendRaw('GET', '/api/storage/' . rawurlencode($key), null, null);
        return $resp ?? '';
    }

    /** Remove the object at $key. */
    public function delete(string $key): array
    {
        return $this->client->request('DELETE', '/api/storage/' . rawurlencode($key));
    }
}
