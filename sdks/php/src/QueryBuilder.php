<?php

declare(strict_types=1);

namespace Backlex;

/** Chainable builder that compiles to a ListQuery array and runs it. */
final class QueryBuilder
{
    /** @var callable */
    private $listFn;
    private array $q = [
        'filter' => null,
        'sort' => [],
        'fields' => [],
        'limit' => null,
        'offset' => null,
        'meta' => null,
    ];

    public function __construct(callable $listFn)
    {
        $this->listFn = $listFn;
    }

    public function where(array $cond): self
    {
        $this->q['filter'] = Filter::normalize($cond);
        return $this;
    }

    /** Replace the filter with a raw canonical condition (escape hatch). */
    public function filter(array $cond): self
    {
        $this->q['filter'] = Filter::normalize($cond);
        return $this;
    }

    public function select(string ...$fields): self
    {
        $this->q['fields'] = array_merge($this->q['fields'], $fields);
        return $this;
    }

    public function orderBy(string ...$sorts): self
    {
        $this->q['sort'] = array_merge($this->q['sort'], $sorts);
        return $this;
    }

    public function limit(int $n): self
    {
        $this->q['limit'] = $n;
        return $this;
    }

    public function offset(int $n): self
    {
        $this->q['offset'] = $n;
        return $this;
    }

    /** Request an extra COUNT: "filter_count", "total_count", or "*". */
    public function withMeta(string $m): self
    {
        $this->q['meta'] = $m;
        return $this;
    }

    /** The assembled ListQuery array — the canonical input the API takes. */
    public function toQuery(): array
    {
        return $this->q;
    }

    public function list(): array
    {
        return ($this->listFn)($this->q);
    }
}
