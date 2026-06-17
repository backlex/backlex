using System.Text.Json.Serialization;

namespace Backlex;

/// <summary>
/// The canonical JSON filter grammar ($and / $or / $not / leaf maps). It is a
/// plain string-keyed map; values may be nested <see cref="Condition"/>s, arrays,
/// or scalars. Shared byte-for-byte with the TS / Python / Go SDKs — there is no
/// .NET-specific wire format.
/// </summary>
public sealed class Condition : Dictionary<string, object?>
{
    public Condition() { }

    public Condition(string key, object? value)
    {
        this[key] = value;
    }
}

/// <summary>Query parameters a list/query call serializes into the URL.</summary>
public sealed class ListQuery
{
    public Condition? Filter { get; set; }
    public List<string> Sort { get; } = new();
    public List<string> Fields { get; } = new();
    public List<string> Expand { get; } = new(); // inline single-hop relations
    public int? Limit { get; set; }
    public int? Offset { get; set; }
    public string? Meta { get; set; } // "filter_count" | "total_count" | "*"
    public string? Locale { get; set; } // one locale, or "*" for the full i18n map
    public string? Q { get; set; } // free-text search across readable text fields
}

/// <summary>
/// Per-call options for <c>OneAsync(id, ...)</c>. The single-item read endpoint
/// accepts the same expand/locale params as the list endpoint.
/// </summary>
public sealed class ItemQuery
{
    public List<string> Expand { get; } = new(); // inline single-hop relations
    public string? Locale { get; set; } // one locale, or "*" for the full i18n map
}

/// <summary>One row of an aggregate: {value} ungrouped, or {label, value} grouped.</summary>
public sealed class AggregateRow
{
    [JsonPropertyName("value")] public double Value { get; set; }
    [JsonPropertyName("label")] public object? Label { get; set; }
}

/// <summary>The {"data": [...]} envelope from <c>Collection.AggregateAsync</c>.</summary>
public sealed class AggregateResponse
{
    [JsonPropertyName("data")] public List<AggregateRow> Data { get; set; } = new();
}

/// <summary>Result of a collection list/query call.</summary>
public sealed class ListResponse<T>
{
    [JsonPropertyName("data")] public List<T> Data { get; set; } = new();
    [JsonPropertyName("limit")] public int Limit { get; set; }
    [JsonPropertyName("offset")] public int Offset { get; set; }
    [JsonPropertyName("meta")] public Dictionary<string, int>? Meta { get; set; }
}

/// <summary>Single-item envelope: <c>{ "data": {...} }</c>.</summary>
public sealed class ItemResponse<T>
{
    [JsonPropertyName("data")] public T Data { get; set; } = default!;
}

/// <summary>A realtime event frame: <c>{ "event": ..., "data": {...} }</c>.</summary>
public sealed class ItemEvent<T>
{
    [JsonPropertyName("event")] public string Event { get; set; } = "";
    [JsonPropertyName("data")] public T Data { get; set; } = default!;
}

/// <summary>The authenticated principal returned by sign-in/up.</summary>
public sealed class AuthUser
{
    [JsonPropertyName("id")] public string Id { get; set; } = "";
    [JsonPropertyName("email")] public string Email { get; set; } = "";
    [JsonPropertyName("name")] public string? Name { get; set; }
    [JsonPropertyName("image")] public string? Image { get; set; }
}

/// <summary>The sign-in/up envelope. <see cref="Token"/> is only set in app mode.</summary>
public sealed class AuthResult
{
    [JsonPropertyName("user")] public AuthUser User { get; set; } = new();
    [JsonPropertyName("token")] public string? Token { get; set; }
}

/// <summary>The <c>{ "ok": true }</c> envelope returned by delete endpoints.</summary>
public sealed class DeleteResult
{
    [JsonPropertyName("ok")] public bool Ok { get; set; }
}
