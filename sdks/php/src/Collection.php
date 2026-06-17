<?php

declare(strict_types=1);

namespace Backlex;

/** A CRUD handle for one collection. Obtain via $client->from('slug'). */
final class Collection
{
    public function __construct(private Client $client, private string $slug)
    {
    }

    public function list(?array $query = null): array
    {
        return $this->client->request('GET', "/api/items/{$this->slug}" . Client::buildSearch($query));
    }

    /** Fluent builder that compiles to a ListQuery. */
    public function query(): QueryBuilder
    {
        return new QueryBuilder(fn ($q) => $this->list($q));
    }

    /** Single-function aggregate (count/sum/avg/min/max), optionally grouped. */
    public function aggregate(array $body): array
    {
        return $this->client->request('POST', "/api/items/{$this->slug}/aggregate", $body);
    }

    public function one(string $id): array
    {
        return $this->client->request('GET', "/api/items/{$this->slug}/{$id}");
    }

    public function create(array $data): array
    {
        return $this->client->request('POST', "/api/items/{$this->slug}", $data);
    }

    public function update(string $id, array $patch): array
    {
        return $this->client->request('PATCH', "/api/items/{$this->slug}/{$id}", $patch);
    }

    public function delete(string $id): array
    {
        return $this->client->request('DELETE', "/api/items/{$this->slug}/{$id}");
    }
}
