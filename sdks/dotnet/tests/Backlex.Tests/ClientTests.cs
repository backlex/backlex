using System.Net;
using System.Text;
using System.Text.Json;
using Xunit;
using static Backlex.Filter;

namespace Backlex.Tests;

/// <summary>Records the last request and answers with canned responses keyed by
/// path/method — the .NET equivalent of the Python MockTransport tests.</summary>
internal sealed class RecordingHandler : HttpMessageHandler
{
    public HttpRequestMessage? Last;
    public string? LastBody;

    protected override async Task<HttpResponseMessage> SendAsync(
        HttpRequestMessage request, CancellationToken cancellationToken)
    {
        Last = request;
        if (request.Content != null)
            LastBody = await request.Content.ReadAsStringAsync(cancellationToken);

        var path = request.RequestUri!.AbsolutePath;
        static HttpResponseMessage Resp(int code, string json) =>
            new((HttpStatusCode)code) { Content = new StringContent(json, Encoding.UTF8, "application/json") };

        if (path == "/api/items/missing")
            return Resp(404, "{\"error\":{\"code\":\"NOT_FOUND\",\"message\":\"no such collection\"}}");
        if (path.EndsWith("/aggregate", StringComparison.Ordinal))
            return Resp(200, "{\"data\":[{\"value\":42}]}");
        if (path.EndsWith("/list-sessions", StringComparison.Ordinal))
            return Resp(200, "[{\"id\":\"s1\",\"token\":\"sess_1\"}]");
        // Workspace sign-in (email or email-otp) returns a session token.
        if (request.Method == HttpMethod.Post && path.StartsWith("/api/t/", StringComparison.Ordinal)
            && path.Contains("/sign-in/email", StringComparison.Ordinal))
            return Resp(200, "{\"user\":{\"id\":\"u1\",\"email\":\"a@b.c\"},\"token\":\"tok_123\"}");
        if (request.Method == HttpMethod.Delete)
            return Resp(200, "{\"ok\":true}");
        if (request.Method == HttpMethod.Post || request.Method == HttpMethod.Patch)
            return Resp(200, "{\"data\":{\"id\":\"x1\"}}");
        // Single-item read: /api/items/<slug>/<id> — object-shaped data.
        if (request.Method == HttpMethod.Get && path.Count(c => c == '/') == 4)
            return Resp(200, "{\"data\":{\"id\":\"x1\"}}");
        return Resp(200, "{\"data\":[],\"limit\":50,\"offset\":0}");
    }
}

public class ClientTests
{
    private static (BacklexClient, RecordingHandler) Make(BacklexClientOptions? opts = null)
    {
        var h = new RecordingHandler();
        opts ??= new BacklexClientOptions();
        opts.HttpClient = new HttpClient(h);
        return (new BacklexClient("http://test", opts), h);
    }

    private static string? FilterParam(Uri uri)
    {
        foreach (var pair in uri.Query.TrimStart('?').Split('&'))
        {
            var i = pair.IndexOf('=');
            if (i > 0 && pair[..i] == "filter")
                return Uri.UnescapeDataString(pair[(i + 1)..]);
        }
        return null;
    }

    [Fact]
    public async Task PasswordResetHitsTheRightPath()
    {
        var (client, h) = Make();
        await client.Auth.RequestPasswordResetAsync("a@b.c");
        Assert.Equal("/api/auth/request-password-reset", h.Last!.RequestUri!.AbsolutePath);
    }

    [Fact]
    public async Task EmailOtpFlow()
    {
        var (client, h) = Make();
        await client.Auth.SendVerificationOtpAsync("a@b.c");
        Assert.Equal("/api/auth/email-otp/send-verification-otp", h.Last!.RequestUri!.AbsolutePath);

        var (app, ha) = Make(new BacklexClientOptions { Workspace = "myapp" });
        var res = await app.Auth.SignInEmailOtpAsync("a@b.c", "123456");
        Assert.Equal("/api/t/myapp/auth/sign-in/email-otp", ha.Last!.RequestUri!.AbsolutePath);
        Assert.Equal("tok_123", res.Token);
        Assert.Equal("tok_123", app.Auth.Token);
    }

    [Fact]
    public async Task SessionManagement()
    {
        var (client, h) = Make();
        var sessions = await client.Auth.ListSessionsAsync();
        Assert.Equal("/api/auth/list-sessions", h.Last!.RequestUri!.AbsolutePath);
        Assert.Equal("sess_1", sessions[0]["token"]?.ToString());

        await client.Auth.RevokeSessionAsync("sess_1");
        Assert.Equal("/api/auth/revoke-session", h.Last!.RequestUri!.AbsolutePath);
        Assert.Contains("sess_1", h.LastBody);

        await client.Auth.RevokeOtherSessionsAsync();
        Assert.Equal("/api/auth/revoke-other-sessions", h.Last!.RequestUri!.AbsolutePath);
    }

    [Fact]
    public async Task ChangePasswordHitsTheRightPath()
    {
        var (client, h) = Make();
        await client.Auth.ChangePasswordAsync("new", "old");
        Assert.Equal("/api/auth/change-password", h.Last!.RequestUri!.AbsolutePath);
    }

    [Fact]
    public async Task QueryExtrasSerialize()
    {
        var (client, h) = Make();
        await client.From<Dictionary<string, object?>>("posts").Query()
            .Expand("author").Locale("tr").Search("hi").ListAsync();
        var query = h.Last!.RequestUri!.Query;
        Assert.Contains("expand=author", query);
        Assert.Contains("locale=tr", query);
        Assert.Contains("q=hi", query);
    }

    [Fact]
    public async Task OneForwardsExpandAndLocale()
    {
        var (client, h) = Make();
        var q = new ItemQuery { Locale = "tr" };
        q.Expand.Add("author");
        await client.From<Dictionary<string, object?>>("posts").OneAsync("p1", q);
        Assert.Equal("/api/items/posts/p1", h.Last!.RequestUri!.AbsolutePath);
        Assert.Contains("expand=author", h.Last!.RequestUri!.Query);
        Assert.Contains("locale=tr", h.Last!.RequestUri!.Query);
    }

    [Fact]
    public async Task PublishUnpublishPaths()
    {
        var (client, h) = Make();
        await client.From<Dictionary<string, object?>>("posts").PublishAsync("p1");
        Assert.Equal("/api/items/posts/p1/publish", h.Last!.RequestUri!.AbsolutePath);
        await client.From<Dictionary<string, object?>>("posts").UnpublishAsync("p1");
        Assert.Contains("unpublish=1", h.Last!.RequestUri!.Query);
    }

    [Fact]
    public async Task AggregateHitsTheRightPath()
    {
        var (client, h) = Make();
        var res = await client.From<Dictionary<string, object?>>("orders")
            .AggregateAsync(new Dictionary<string, object?> { ["agg"] = "sum", ["field"] = "total" });
        Assert.Equal("/api/items/orders/aggregate", h.Last!.RequestUri!.AbsolutePath);
        Assert.Equal(42, res.Data[0].Value);
    }

    [Fact]
    public async Task TenantHeaderIsSent()
    {
        var (client, h) = Make(new BacklexClientOptions { Tenant = "myapp" });
        await client.From<Dictionary<string, object?>>("posts").ListAsync();
        Assert.True(h.Last!.Headers.TryGetValues("X-Backlex-Tenant", out var v));
        Assert.Equal("myapp", v!.First());
    }

    // Org and trace ride the same chokepoint the tenant header does, so they
    // reach every request path rather than three of the four.
    [Fact]
    public async Task OrgHeaderIsSentAndSettable()
    {
        var (client, h) = Make(new BacklexClientOptions { Org = "acme" });
        await client.From<Dictionary<string, object?>>("posts").ListAsync();
        Assert.True(h.Last!.Headers.TryGetValues("X-Backlex-Org", out var v));
        Assert.Equal("acme", v!.First());

        client.Org = "other";
        await client.From<Dictionary<string, object?>>("posts").ListAsync();
        Assert.True(h.Last!.Headers.TryGetValues("X-Backlex-Org", out var v2));
        Assert.Equal("other", v2!.First());
    }

    [Fact]
    public async Task TraceparentIsW3CShapedFreshPerCallAndOptional()
    {
        var (client, h) = Make();
        await client.From<Dictionary<string, object?>>("posts").ListAsync();
        Assert.True(h.Last!.Headers.TryGetValues("traceparent", out var tp));
        var first = tp!.First();
        Assert.Matches("^00-[0-9a-f]{32}-[0-9a-f]{16}-01$", first);

        // A span id reused across calls would collapse them into one span.
        await client.From<Dictionary<string, object?>>("posts").ListAsync();
        h.Last!.Headers.TryGetValues("traceparent", out var tp2);
        Assert.NotEqual(first, tp2!.First());

        var (quiet, qh) = Make(new BacklexClientOptions { Tracing = false });
        await quiet.From<Dictionary<string, object?>>("posts").ListAsync();
        Assert.False(qh.Last!.Headers.TryGetValues("traceparent", out _));
        Assert.False(qh.Last!.Headers.TryGetValues("X-Backlex-Org", out _));
    }

    [Fact]
    public async Task QueryStringFilterIsNotDoubleEncoded()
    {
        var (client, h) = Make(new BacklexClientOptions { ApiKey = "pak_x" });
        await client.From<Dictionary<string, object?>>("orders").Query()
            .Where(Eq("status", "active"))
            .OrderBy("-created_at")
            .Limit(5)
            .ListAsync();

        Assert.Equal(HttpMethod.Get, h.Last!.Method);
        Assert.Equal("/api/items/orders", h.Last.RequestUri!.AbsolutePath);

        // If double percent-encoded, this Parse would throw.
        using var doc = JsonDocument.Parse(FilterParam(h.Last.RequestUri)!);
        Assert.Equal("active", doc.RootElement.GetProperty("status").GetProperty("_eq").GetString());
    }

    [Fact]
    public async Task ApiKeyBearerHeader()
    {
        var (client, h) = Make(new BacklexClientOptions { ApiKey = "pak_secret" });
        await client.From<Dictionary<string, object?>>("posts").ListAsync();
        Assert.Equal("Bearer pak_secret", h.Last!.Headers.Authorization?.ToString());
    }

    [Fact]
    public async Task CrudMethodsPathsAndBody()
    {
        var (client, h) = Make(new BacklexClientOptions { ApiKey = "pak_x" });
        var posts = client.From<Dictionary<string, object?>>("posts");

        await posts.CreateAsync(new Dictionary<string, object?> { ["title"] = "Hi" });
        Assert.Equal(HttpMethod.Post, h.Last!.Method);
        Assert.Equal("/api/items/posts", h.Last.RequestUri!.AbsolutePath);
        using (var sent = JsonDocument.Parse(h.LastBody!))
            Assert.Equal("Hi", sent.RootElement.GetProperty("title").GetString());

        await posts.UpdateAsync("p1", new Dictionary<string, object?> { ["title"] = "Edit" });
        Assert.Equal(HttpMethod.Patch, h.Last.Method);
        Assert.Equal("/api/items/posts/p1", h.Last.RequestUri!.AbsolutePath);

        var del = await posts.DeleteAsync("p1");
        Assert.Equal(HttpMethod.Delete, h.Last.Method);
        Assert.True(del.Ok);
    }

    [Fact]
    public async Task AppModeTokenCaptureAndReplay()
    {
        var (client, h) = Make(new BacklexClientOptions { Workspace = "myapp" });

        var res = await client.Auth.SignInAsync("a@b.c", "pw");
        Assert.Equal("/api/t/myapp/auth/sign-in/email", h.Last!.RequestUri!.AbsolutePath);
        Assert.Equal("tok_123", res.Token);
        Assert.Equal("tok_123", client.Auth.Token);

        await client.From<Dictionary<string, object?>>("posts").ListAsync();
        Assert.Equal("Bearer tok_123", h.Last.Headers.Authorization?.ToString());

        await client.Auth.SignOutAsync();
        Assert.Null(client.Auth.Token);
    }

    [Fact]
    public async Task ErrorEnvelopeBecomesBacklexException()
    {
        var (client, _) = Make(new BacklexClientOptions { ApiKey = "pak_x" });
        var ex = await Assert.ThrowsAsync<BacklexException>(() =>
            client.From<Dictionary<string, object?>>("missing").ListAsync());
        Assert.Equal(404, ex.Status);
        Assert.Equal("NOT_FOUND", ex.Code);
        Assert.Equal("no such collection", ex.Message);
    }

    [Fact]
    public async Task ControlPlaneAuthDoesNotCaptureToken()
    {
        var (client, h) = Make(); // no workspace → control plane
        await client.Auth.SignInAsync("a@b.c", "pw");
        Assert.Equal("/api/auth/sign-in/email", h.Last!.RequestUri!.AbsolutePath);
        Assert.Null(client.Auth.Token);
    }
}
