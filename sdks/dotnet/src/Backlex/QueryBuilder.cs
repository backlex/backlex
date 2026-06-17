namespace Backlex;

/// <summary>
/// Static condition constructors — a C# port of the leaf/logical helpers in
/// query.ts. Compose them and pass to <c>QueryBuilder.Where</c>. Everything
/// compiles to the canonical JSON <see cref="Condition"/> the REST API speaks.
///
/// <code>
/// using static Backlex.Filter;
/// var rows = await client.From&lt;Order&gt;("orders").Query()
///     .Where(And(
///         Eq("status", "active"),
///         Gte("total", 100),
///         Rel("customer", Eq("tier", "gold")),               // -> "customer.tier"
///         Gte("placed_at", Now(sub: new() { ["months"] = 1 })),
///     ))
///     .Select("id", "total", "customer.name")
///     .OrderBy("-placed_at", "id")
///     .Limit(50)
///     .ListAsync();
/// </code>
/// </summary>
public static class Filter
{
    private static Condition Leaf(string field, string op, object? value) =>
        new(field, new Dictionary<string, object?> { [op] = value });

    public static Condition Eq(string field, object? v) => Leaf(field, "_eq", v);
    public static Condition Neq(string field, object? v) => Leaf(field, "_neq", v);
    public static Condition Gt(string field, object? v) => Leaf(field, "_gt", v);
    public static Condition Gte(string field, object? v) => Leaf(field, "_gte", v);
    public static Condition Lt(string field, object? v) => Leaf(field, "_lt", v);
    public static Condition Lte(string field, object? v) => Leaf(field, "_lte", v);
    public static Condition In(string field, IEnumerable<object?> vs) => Leaf(field, "_in", vs.ToArray());
    public static Condition Nin(string field, IEnumerable<object?> vs) => Leaf(field, "_nin", vs.ToArray());
    public static Condition Between(string field, object? lo, object? hi) => Leaf(field, "_between", new[] { lo, hi });
    public static Condition IsNull(string field, bool isNull = true) => Leaf(field, "_null", isNull);
    public static Condition Empty(string field) => Leaf(field, "_empty", true);
    public static Condition Nempty(string field) => Leaf(field, "_nempty", true);
    public static Condition Contains(string field, string v) => Leaf(field, "_contains", v);
    public static Condition IContains(string field, string v) => Leaf(field, "_icontains", v);
    public static Condition StartsWith(string field, string v) => Leaf(field, "_starts_with", v);
    public static Condition EndsWith(string field, string v) => Leaf(field, "_ends_with", v);

    public static Condition And(params Condition[] conds) => new("$and", conds);
    public static Condition Or(params Condition[] conds) => new("$or", conds);
    public static Condition Not(Condition cond) => new("$not", cond);

    /// <summary>
    /// Traverse a relation one hop: every leaf key produced by <paramref name="conds"/>
    /// is prefixed with <paramref name="head"/> + ".". Multiple conds are ANDed first.
    /// </summary>
    public static Condition Rel(string head, params Condition[] conds)
    {
        var inner = conds.Length == 1 ? conds[0] : And(conds);
        return PrefixKeys(inner, head);
    }

    /// <summary>Relative-date value, e.g. <c>Now(sub: new() { ["months"] = 1 })</c>.</summary>
    public static Dictionary<string, object?> Now(
        IDictionary<string, int>? add = null,
        IDictionary<string, int>? sub = null)
    {
        var opts = new Dictionary<string, object?>();
        if (add != null) opts["add"] = add;
        if (sub != null) opts["sub"] = sub;
        return new Dictionary<string, object?> { ["$now"] = opts };
    }

    private static Condition PrefixKeys(Condition cond, string head)
    {
        if (cond.TryGetValue("$and", out var a) && a is object[] aarr)
            return new Condition("$and", aarr.Select(x => PrefixKeys((Condition)x!, head)).ToArray());
        if (cond.TryGetValue("$or", out var o) && o is object[] oarr)
            return new Condition("$or", oarr.Select(x => PrefixKeys((Condition)x!, head)).ToArray());
        if (cond.TryGetValue("$not", out var n) && n is Condition nc)
            return new Condition("$not", PrefixKeys(nc, head));

        var outc = new Condition();
        foreach (var kv in cond) outc[$"{head}.{kv.Key}"] = kv.Value;
        return outc;
    }

    /// <summary>
    /// Turn any accepted filter shape into the canonical Condition: handles
    /// $and/$or/$not (and their _ aliases) and implicit equality
    /// (<c>{"status":"active"}</c> -&gt; <c>{"status":{"_eq":"active"}}</c>). Idempotent.
    /// </summary>
    public static Condition Normalize(object? raw)
    {
        if (raw is not IDictionary<string, object?> m) return new Condition();

        if (First(m, "$and", "_and") is object[] aarr)
            return new Condition("$and", aarr.Select(Normalize).ToArray());
        if (First(m, "$or", "_or") is object[] oarr)
            return new Condition("$or", oarr.Select(Normalize).ToArray());
        if (TryFirst(m, out var not, "$not", "_not"))
            return new Condition("$not", Normalize(not));

        var outc = new Condition();
        foreach (var kv in m)
        {
            if (kv.Value is IDictionary<string, object?> obj && LooksLikeComparison(obj))
                outc[kv.Key] = kv.Value;
            else if (kv.Value is IDictionary<string, object?>)
                outc[kv.Key] = kv.Value; // unknown object shape — pass through
            else
                outc[kv.Key] = new Dictionary<string, object?> { ["_eq"] = kv.Value };
        }
        return outc;
    }

    private static object? First(IDictionary<string, object?> m, params string[] keys)
    {
        foreach (var k in keys)
            if (m.TryGetValue(k, out var v))
                return v;
        return null;
    }

    private static bool TryFirst(IDictionary<string, object?> m, out object? value, params string[] keys)
    {
        foreach (var k in keys)
            if (m.TryGetValue(k, out value))
                return true;
        value = null;
        return false;
    }

    private static bool LooksLikeComparison(IDictionary<string, object?> o)
    {
        if (o.Count == 0) return false;
        foreach (var k in o.Keys)
            if (k.Length == 0 || k[0] != '_')
                return false;
        return true;
    }
}

/// <summary>Chainable builder that compiles to a <see cref="ListQuery"/> and runs it.</summary>
public sealed class QueryBuilder<T>
{
    private readonly Func<ListQuery, Task<ListResponse<T>>> _listFn;
    private readonly ListQuery _q = new();

    internal QueryBuilder(Func<ListQuery, Task<ListResponse<T>>> listFn) => _listFn = listFn;

    public QueryBuilder<T> Where(Condition cond)
    {
        _q.Filter = Filter.Normalize(cond);
        return this;
    }

    /// <summary>Replace the filter with a raw canonical condition (escape hatch).</summary>
    public QueryBuilder<T> RawFilter(Condition cond)
    {
        _q.Filter = Filter.Normalize(cond);
        return this;
    }

    public QueryBuilder<T> Select(params string[] fields)
    {
        _q.Fields.AddRange(fields);
        return this;
    }

    public QueryBuilder<T> OrderBy(params string[] sorts)
    {
        _q.Sort.AddRange(sorts);
        return this;
    }

    /// <summary>Inline single-hop relations (replaces each FK with the related object).</summary>
    public QueryBuilder<T> Expand(params string[] rels)
    {
        _q.Expand.AddRange(rels);
        return this;
    }

    /// <summary>Project i18n_text fields to one locale, or "*" for the full map.</summary>
    public QueryBuilder<T> Locale(string loc)
    {
        _q.Locale = loc;
        return this;
    }

    /// <summary>Free-text search across readable text fields.</summary>
    public QueryBuilder<T> Search(string text)
    {
        _q.Q = text;
        return this;
    }

    public QueryBuilder<T> Limit(int n)
    {
        _q.Limit = n;
        return this;
    }

    public QueryBuilder<T> Offset(int n)
    {
        _q.Offset = n;
        return this;
    }

    /// <summary>Request an extra COUNT: "filter_count", "total_count", or "*".</summary>
    public QueryBuilder<T> WithMeta(string m)
    {
        _q.Meta = m;
        return this;
    }

    /// <summary>The assembled <see cref="ListQuery"/> — the canonical input the API takes.</summary>
    public ListQuery ToQuery() => _q;

    public Task<ListResponse<T>> ListAsync() => _listFn(_q);
}
