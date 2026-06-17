<?php

declare(strict_types=1);

namespace Backlex;

/**
 * Static condition constructors — a PHP port of the leaf/logical helpers in
 * query.ts. Compose them and pass to QueryBuilder::where. Everything compiles to
 * the canonical JSON Condition the REST API speaks.
 *
 *   $rows = $client->from('orders')->query()
 *       ->where(Filter::and_(
 *           Filter::eq('status', 'active'),
 *           Filter::gte('total', 100),
 *           Filter::rel('customer', Filter::eq('tier', 'gold')),   // -> "customer.tier"
 *           Filter::gte('placed_at', Filter::now(sub: ['months' => 1])),
 *       ))
 *       ->select('id', 'total', 'customer.name')
 *       ->orderBy('-placed_at', 'id')
 *       ->limit(50)
 *       ->list();
 */
final class Filter
{
    private static function leaf(string $field, string $op, mixed $value): array
    {
        return [$field => [$op => $value]];
    }

    public static function eq(string $f, mixed $v): array { return self::leaf($f, '_eq', $v); }
    public static function neq(string $f, mixed $v): array { return self::leaf($f, '_neq', $v); }
    public static function gt(string $f, mixed $v): array { return self::leaf($f, '_gt', $v); }
    public static function gte(string $f, mixed $v): array { return self::leaf($f, '_gte', $v); }
    public static function lt(string $f, mixed $v): array { return self::leaf($f, '_lt', $v); }
    public static function lte(string $f, mixed $v): array { return self::leaf($f, '_lte', $v); }
    public static function in_(string $f, array $vs): array { return self::leaf($f, '_in', $vs); }
    public static function nin(string $f, array $vs): array { return self::leaf($f, '_nin', $vs); }
    public static function between(string $f, mixed $lo, mixed $hi): array { return self::leaf($f, '_between', [$lo, $hi]); }
    public static function isNull(string $f, bool $isNull = true): array { return self::leaf($f, '_null', $isNull); }
    public static function empty(string $f): array { return self::leaf($f, '_empty', true); }
    public static function nempty(string $f): array { return self::leaf($f, '_nempty', true); }
    public static function contains(string $f, string $v): array { return self::leaf($f, '_contains', $v); }
    public static function icontains(string $f, string $v): array { return self::leaf($f, '_icontains', $v); }
    public static function startsWith(string $f, string $v): array { return self::leaf($f, '_starts_with', $v); }
    public static function endsWith(string $f, string $v): array { return self::leaf($f, '_ends_with', $v); }

    public static function and_(array ...$conds): array { return ['$and' => $conds]; }
    public static function or_(array ...$conds): array { return ['$or' => $conds]; }
    public static function not_(array $cond): array { return ['$not' => $cond]; }

    /**
     * Traverse a relation one hop: every leaf key produced by $conds is prefixed
     * with "head.". Multiple conds are ANDed first.
     */
    public static function rel(string $head, array ...$conds): array
    {
        $inner = count($conds) === 1 ? $conds[0] : ['$and' => $conds];
        return self::prefixKeys($inner, $head);
    }

    /** Relative-date value, e.g. Filter::now(sub: ['months' => 1]). */
    public static function now(?array $add = null, ?array $sub = null): array
    {
        $opts = [];
        if ($add !== null) {
            $opts['add'] = $add;
        }
        if ($sub !== null) {
            $opts['sub'] = $sub;
        }
        return ['$now' => $opts];
    }

    private static function prefixKeys(array $cond, string $head): array
    {
        if (isset($cond['$and'])) {
            return ['$and' => array_map(fn ($c) => self::prefixKeys($c, $head), $cond['$and'])];
        }
        if (isset($cond['$or'])) {
            return ['$or' => array_map(fn ($c) => self::prefixKeys($c, $head), $cond['$or'])];
        }
        if (isset($cond['$not'])) {
            return ['$not' => self::prefixKeys($cond['$not'], $head)];
        }
        $out = [];
        foreach ($cond as $k => $v) {
            $out["{$head}.{$k}"] = $v;
        }
        return $out;
    }

    /**
     * Turn any accepted filter shape into the canonical Condition: handles
     * $and/$or/$not (and their _ aliases) and implicit equality
     * (['status' => 'active'] -> ['status' => ['_eq' => 'active']]). Idempotent.
     */
    public static function normalize(mixed $raw): array
    {
        if (!is_array($raw)) {
            return [];
        }

        $and = $raw['$and'] ?? $raw['_and'] ?? null;
        if (is_array($and) && array_is_list($and)) {
            return ['$and' => array_map(fn ($c) => self::normalize($c), $and)];
        }
        $or = $raw['$or'] ?? $raw['_or'] ?? null;
        if (is_array($or) && array_is_list($or)) {
            return ['$or' => array_map(fn ($c) => self::normalize($c), $or)];
        }
        if (array_key_exists('$not', $raw) || array_key_exists('_not', $raw)) {
            return ['$not' => self::normalize($raw['$not'] ?? $raw['_not'])];
        }

        $out = [];
        foreach ($raw as $k => $v) {
            // A list array (or scalar) is a value -> implicit equality; only an
            // associative array is treated as an object (comparison/nested).
            if (is_array($v) && !array_is_list($v) && self::looksLikeComparison($v)) {
                $out[$k] = $v;
            } elseif (is_array($v) && !array_is_list($v)) {
                $out[$k] = $v; // unknown object shape — pass through
            } else {
                $out[$k] = ['_eq' => $v];
            }
        }
        return $out;
    }

    private static function looksLikeComparison(array $o): bool
    {
        if (count($o) === 0) {
            return false;
        }
        foreach (array_keys($o) as $k) {
            if (!is_string($k) || !str_starts_with($k, '_')) {
                return false;
            }
        }
        return true;
    }
}
