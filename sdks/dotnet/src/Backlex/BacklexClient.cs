using System.Net;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace Backlex;

/// <summary>Options for <see cref="BacklexClient"/>.</summary>
public sealed class BacklexClientOptions
{
    /// <summary>Static server key (pak_...) sent as a bearer on every call.</summary>
    public string? ApiKey { get; set; }

    /// <summary>Workspace slug — puts the client in app mode (auth + token capture).</summary>
    public string? Workspace { get; set; }

    /// <summary>Restore a previously-saved workspace session token (app mode).</summary>
    public string? Token { get; set; }

    /// <summary>
    /// Scope every request to a tenant/workspace (slug or id) via the
    /// X-Backlex-Tenant header — for anonymous public reads or a pak_ key
    /// addressing a tenant other than its home one. Ignored by the server for
    /// app-mode bearer sessions.
    /// </summary>
    public string? Tenant { get; set; }

    /// <summary>Custom HttpClient (timeouts, proxies, testing).</summary>
    public HttpClient? HttpClient { get; set; }
}

/// <summary>
/// The official .NET client for the backlex API — a thin, typed wrapper over the
/// same REST + SSE surface the TypeScript SDK (@backlex/client) speaks. Three auth
/// modes: server key, workspace app mode (token capture), or cookie session.
/// </summary>
public sealed class BacklexClient
{
    internal static readonly JsonSerializerOptions Json = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        PropertyNameCaseInsensitive = true,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    private readonly string? _apiKey;
    private readonly string? _tenant;

    internal string Url { get; }
    internal string? Workspace { get; }
    internal HttpClient Http { get; }
    internal string? AppToken { get; set; }

    public Auth Auth { get; }
    public Storage Storage { get; }

    public BacklexClient(string baseUrl, BacklexClientOptions? options = null)
    {
        var o = options ?? new BacklexClientOptions();
        Url = baseUrl.TrimEnd('/');
        _apiKey = o.ApiKey;
        _tenant = o.Tenant;
        Workspace = o.Workspace;
        AppToken = o.Token;
        // A cookie container keeps same-origin cookie sessions working across calls.
        Http = o.HttpClient ?? new HttpClient(new HttpClientHandler
        {
            UseCookies = true,
            CookieContainer = new CookieContainer(),
        });
        Auth = new Auth(this);
        Storage = new Storage(this);
    }

    internal void ApplyAuth(HttpRequestMessage req)
    {
        if (!string.IsNullOrEmpty(_apiKey))
            req.Headers.TryAddWithoutValidation("Authorization", $"Bearer {_apiKey}");
        else if (!string.IsNullOrEmpty(AppToken))
            req.Headers.TryAddWithoutValidation("Authorization", $"Bearer {AppToken}");
        if (!string.IsNullOrEmpty(_tenant))
            req.Headers.TryAddWithoutValidation("X-Backlex-Tenant", _tenant);
    }

    /// <summary>Typed CRUD handle for a collection.</summary>
    public Collection<T> From<T>(string slug) => new(this, slug);

    /// <summary>Raw escape hatch — issues a request with auth headers applied.</summary>
    public async Task<TOut?> RequestAsync<TOut>(HttpMethod method, string path, object? body = null)
    {
        using var req = new HttpRequestMessage(method, Url + path);
        if (body != null)
        {
            var json = JsonSerializer.Serialize(body, Json);
            req.Content = new StringContent(json, Encoding.UTF8, "application/json");
        }
        ApplyAuth(req);

        using var resp = await Http.SendAsync(req).ConfigureAwait(false);
        if (!resp.IsSuccessStatusCode)
            throw await MakeError(resp).ConfigureAwait(false);
        if (resp.StatusCode == HttpStatusCode.NoContent)
            return default;

        var text = await resp.Content.ReadAsStringAsync().ConfigureAwait(false);
        if (string.IsNullOrEmpty(text))
            return default;
        return JsonSerializer.Deserialize<TOut>(text, Json);
    }

    internal async Task<BacklexException> MakeError(HttpResponseMessage resp)
    {
        var status = (int)resp.StatusCode;
        var code = "UNKNOWN";
        var message = $"HTTP {status}";
        object? details = null;
        try
        {
            var text = await resp.Content.ReadAsStringAsync().ConfigureAwait(false);
            if (!string.IsNullOrEmpty(text))
            {
                using var doc = JsonDocument.Parse(text);
                if (doc.RootElement.TryGetProperty("error", out var err))
                {
                    if (err.TryGetProperty("code", out var c) && c.ValueKind == JsonValueKind.String)
                        code = c.GetString()!;
                    if (err.TryGetProperty("message", out var msg) && msg.ValueKind == JsonValueKind.String)
                        message = msg.GetString()!;
                    if (err.TryGetProperty("details", out var d))
                        details = d.Clone();
                }
            }
        }
        catch (JsonException)
        {
            // Non-JSON error body — keep the generic message.
        }
        return new BacklexException(status, code, message, details);
    }

    /// <summary>
    /// Serialize a ListQuery into a URL query string (mirrors buildSearch in
    /// index.ts). The filter is compact JSON, percent-encoded exactly once.
    /// </summary>
    internal static string BuildSearch(ListQuery? q)
    {
        if (q == null) return "";
        var parts = new List<string>();
        if (q.Filter is { Count: > 0 })
            parts.Add("filter=" + Uri.EscapeDataString(JsonSerializer.Serialize(q.Filter, Json)));
        if (q.Sort.Count > 0)
            parts.Add("sort=" + Uri.EscapeDataString(string.Join(",", q.Sort)));
        if (q.Fields.Count > 0)
            parts.Add("fields=" + Uri.EscapeDataString(string.Join(",", q.Fields)));
        if (q.Expand.Count > 0)
            parts.Add("expand=" + Uri.EscapeDataString(string.Join(",", q.Expand)));
        if (q.Limit.HasValue)
            parts.Add("limit=" + q.Limit.Value);
        if (q.Offset.HasValue)
            parts.Add("offset=" + q.Offset.Value);
        if (!string.IsNullOrEmpty(q.Meta))
            parts.Add("meta=" + Uri.EscapeDataString(q.Meta));
        if (!string.IsNullOrEmpty(q.Locale))
            parts.Add("locale=" + Uri.EscapeDataString(q.Locale));
        if (!string.IsNullOrEmpty(q.Q))
            parts.Add("q=" + Uri.EscapeDataString(q.Q));
        return parts.Count > 0 ? "?" + string.Join("&", parts) : "";
    }

    /// <summary>
    /// Serializes the per-call options for <c>OneAsync(id, ...)</c> — a strict
    /// subset of <see cref="BuildSearch"/> (expand + locale).
    /// </summary>
    internal static string BuildItemSearch(ItemQuery? q)
    {
        if (q == null) return "";
        var parts = new List<string>();
        if (q.Expand.Count > 0)
            parts.Add("expand=" + Uri.EscapeDataString(string.Join(",", q.Expand)));
        if (!string.IsNullOrEmpty(q.Locale))
            parts.Add("locale=" + Uri.EscapeDataString(q.Locale));
        return parts.Count > 0 ? "?" + string.Join("&", parts) : "";
    }
}
