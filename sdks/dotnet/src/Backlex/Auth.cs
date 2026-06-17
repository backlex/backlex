using System.Text.Json.Serialization;

namespace Backlex;

/// <summary>One enabled sign-in method in the public auth surface.</summary>
public sealed class AuthProvider
{
    [JsonPropertyName("id")] public string Id { get; set; } = "";
    [JsonPropertyName("kind")] public string Kind { get; set; } = "";
    [JsonPropertyName("label")] public string Label { get; set; } = "";
    [JsonPropertyName("enabled")] public bool Enabled { get; set; }
}

/// <summary>The public description of a workspace's auth (no secrets).</summary>
public sealed class AuthSurface
{
    [JsonPropertyName("tenantId")] public string? TenantId { get; set; }
    [JsonPropertyName("providers")] public List<AuthProvider> Providers { get; set; } = new();
    [JsonPropertyName("policy")] public Dictionary<string, object?> Policy { get; set; } = new();
}

/// <summary>The {"url","redirect"} envelope from SignInSocial.</summary>
public sealed class SocialResult
{
    [JsonPropertyName("url")] public string Url { get; set; } = "";
    [JsonPropertyName("redirect")] public bool Redirect { get; set; }
}

/// <summary>
/// Auth surface. In app mode (Workspace set) calls target that workspace's own
/// auth pool (/api/t/&lt;slug&gt;/auth/*); otherwise the control plane.
/// </summary>
public sealed class Auth
{
    private readonly BacklexClient _client;

    internal Auth(BacklexClient client) => _client = client;

    private string Base => string.IsNullOrEmpty(_client.Workspace)
        ? "/api/auth"
        : $"/api/t/{Uri.EscapeDataString(_client.Workspace)}/auth";

    private AuthResult Capture(AuthResult r)
    {
        if (!string.IsNullOrEmpty(_client.Workspace) && !string.IsNullOrEmpty(r.Token))
            _client.AppToken = r.Token;
        return r;
    }

    /// <summary>Sign up with email + password. Pass name=null to omit it.</summary>
    public async Task<AuthResult> SignUpAsync(string email, string password, string? name = null)
    {
        var body = new Dictionary<string, object?> { ["email"] = email, ["password"] = password };
        if (name != null) body["name"] = name;
        var r = await _client.RequestAsync<AuthResult>(HttpMethod.Post, $"{Base}/sign-up/email", body)
            .ConfigureAwait(false) ?? new AuthResult();
        return Capture(r);
    }

    public async Task<AuthResult> SignInAsync(string email, string password)
    {
        var body = new Dictionary<string, object?> { ["email"] = email, ["password"] = password };
        var r = await _client.RequestAsync<AuthResult>(HttpMethod.Post, $"{Base}/sign-in/email", body)
            .ConfigureAwait(false) ?? new AuthResult();
        return Capture(r);
    }

    /// <summary>Begin an OAuth sign-in; navigate the user to the returned URL.</summary>
    public async Task<SocialResult> SignInSocialAsync(
        string provider, string? callbackUrl = null, string? errorCallbackUrl = null)
    {
        var body = new Dictionary<string, object?> { ["provider"] = provider, ["disableRedirect"] = true };
        if (callbackUrl != null) body["callbackURL"] = callbackUrl;
        if (errorCallbackUrl != null) body["errorCallbackURL"] = errorCallbackUrl;
        return await _client.RequestAsync<SocialResult>(HttpMethod.Post, $"{Base}/sign-in/social", body)
            .ConfigureAwait(false) ?? new SocialResult();
    }

    /// <summary>Send a one-time sign-in link by email.</summary>
    public async Task<Dictionary<string, object?>> SignInMagicLinkAsync(string email, string? callbackUrl = null)
    {
        var body = new Dictionary<string, object?> { ["email"] = email };
        if (callbackUrl != null) body["callbackURL"] = callbackUrl;
        return await _client.RequestAsync<Dictionary<string, object?>>(HttpMethod.Post, $"{Base}/sign-in/magic-link", body)
            .ConfigureAwait(false) ?? new();
    }

    /// <summary>Send a password-reset email. <paramref name="redirectTo"/> is the link target.</summary>
    public async Task<Dictionary<string, object?>> RequestPasswordResetAsync(string email, string? redirectTo = null)
    {
        var body = new Dictionary<string, object?> { ["email"] = email };
        if (redirectTo != null) body["redirectTo"] = redirectTo;
        return await _client.RequestAsync<Dictionary<string, object?>>(HttpMethod.Post, $"{Base}/request-password-reset", body)
            .ConfigureAwait(false) ?? new();
    }

    /// <summary>Complete a reset with the token from the email and a new password.</summary>
    public async Task<Dictionary<string, object?>> ResetPasswordAsync(string newPassword, string token) =>
        await _client.RequestAsync<Dictionary<string, object?>>(HttpMethod.Post, $"{Base}/reset-password",
                new Dictionary<string, object?> { ["newPassword"] = newPassword, ["token"] = token })
            .ConfigureAwait(false) ?? new();

    /// <summary>Mint a fresh access JWT from the stored session token (app mode).</summary>
    public async Task<Dictionary<string, object?>> RefreshAsync() =>
        await _client.RequestAsync<Dictionary<string, object?>>(HttpMethod.Post, $"{Base}/token/refresh",
                new Dictionary<string, object?> { ["refreshToken"] = _client.AppToken })
            .ConfigureAwait(false) ?? new();

    /// <summary>Clear the session; in app mode also drops the captured token.</summary>
    public async Task SignOutAsync()
    {
        await _client.RequestAsync<Dictionary<string, object?>>(HttpMethod.Post, $"{Base}/sign-out")
            .ConfigureAwait(false);
        if (!string.IsNullOrEmpty(_client.Workspace))
            _client.AppToken = null;
    }

    /// <summary>Current session payload, or {"user": null}.</summary>
    public async Task<Dictionary<string, object?>> SessionAsync() =>
        await _client.RequestAsync<Dictionary<string, object?>>(HttpMethod.Get, $"{Base}/get-session")
            .ConfigureAwait(false) ?? new();

    /// <summary>Public auth surface (provider list + policy flags).</summary>
    public async Task<AuthSurface> ProvidersAsync()
    {
        var wrap = await _client.RequestAsync<ItemResponse<AuthSurface>>(HttpMethod.Get, $"{Base}/providers")
            .ConfigureAwait(false);
        return wrap?.Data ?? new AuthSurface();
    }

    /// <summary>Current workspace session token (app mode); persist and restore via Options.Token.</summary>
    public string? Token => _client.AppToken;

    /// <summary>Restore a workspace session token (app mode).</summary>
    public void SetToken(string? token) => _client.AppToken = token;
}
