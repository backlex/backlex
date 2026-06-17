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
        if (request.Method == HttpMethod.Post && path == "/api/t/myapp/auth/sign-in/email")
            return Resp(200, "{\"user\":{\"id\":\"u1\",\"email\":\"a@b.c\"},\"token\":\"tok_123\"}");
        if (request.Method == HttpMethod.Delete)
            return Resp(200, "{\"ok\":true}");
        if (request.Method == HttpMethod.Post || request.Method == HttpMethod.Patch)
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
    public async Task TenantHeaderIsSent()
    {
        var (client, h) = Make(new BacklexClientOptions { Tenant = "myapp" });
        await client.From<Dictionary<string, object?>>("posts").ListAsync();
        Assert.True(h.Last!.Headers.TryGetValues("X-Backlex-Tenant", out var v));
        Assert.Equal("myapp", v!.First());
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
