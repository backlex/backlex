using System.Net.Http.Headers;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace Backlex;

/// <summary>Describes one stored object.</summary>
public sealed class FileRow
{
    [JsonPropertyName("key")] public string Key { get; set; } = "";
    [JsonPropertyName("size")] public long Size { get; set; }
    [JsonPropertyName("contentType")] public string? ContentType { get; set; }
    [JsonPropertyName("ownerId")] public string? OwnerId { get; set; }
    [JsonPropertyName("uploadedAt")] public string UploadedAt { get; set; } = "";
}

/// <summary>File operations against /api/storage.</summary>
public sealed class Storage
{
    private readonly BacklexClient _client;

    internal Storage(BacklexClient client) => _client = client;

    /// <summary>List stored objects, optionally filtered by key prefix.</summary>
    public async Task<List<FileRow>> ListAsync(string? prefix = null)
    {
        var path = "/api/storage";
        if (!string.IsNullOrEmpty(prefix))
            path += "?prefix=" + Uri.EscapeDataString(prefix);
        var wrap = await _client.RequestAsync<ItemResponse<List<FileRow>>>(HttpMethod.Get, path)
            .ConfigureAwait(false);
        return wrap?.Data ?? new List<FileRow>();
    }

    /// <summary>Upload bytes under key. Pass contentType/folderId=null to omit them.</summary>
    public async Task<Dictionary<string, object?>> PutAsync(
        string key, byte[] body, string? contentType = null, string? folderId = null)
    {
        var url = $"{_client.Url}/api/storage/{Uri.EscapeDataString(key)}";
        if (!string.IsNullOrEmpty(folderId))
            url += "?folderId=" + Uri.EscapeDataString(folderId);

        using var req = new HttpRequestMessage(HttpMethod.Put, url) { Content = new ByteArrayContent(body) };
        if (!string.IsNullOrEmpty(contentType))
            req.Content.Headers.ContentType = new MediaTypeHeaderValue(contentType);
        _client.ApplyAuth(req);

        using var resp = await _client.Http.SendAsync(req).ConfigureAwait(false);
        if (!resp.IsSuccessStatusCode)
            throw await _client.MakeError(resp).ConfigureAwait(false);
        var text = await resp.Content.ReadAsStringAsync().ConfigureAwait(false);
        return string.IsNullOrEmpty(text)
            ? new Dictionary<string, object?>()
            : JsonSerializer.Deserialize<Dictionary<string, object?>>(text, BacklexClient.Json) ?? new();
    }

    /// <summary>Fetch the raw bytes for key.</summary>
    public async Task<byte[]> DownloadAsync(string key)
    {
        var url = $"{_client.Url}/api/storage/{Uri.EscapeDataString(key)}";
        using var req = new HttpRequestMessage(HttpMethod.Get, url);
        _client.ApplyAuth(req);
        using var resp = await _client.Http.SendAsync(req).ConfigureAwait(false);
        if (!resp.IsSuccessStatusCode)
            throw await _client.MakeError(resp).ConfigureAwait(false);
        return await resp.Content.ReadAsByteArrayAsync().ConfigureAwait(false);
    }

    /// <summary>Remove the object at key.</summary>
    public async Task<DeleteResult> DeleteAsync(string key) =>
        await _client.RequestAsync<DeleteResult>(
            HttpMethod.Delete, $"/api/storage/{Uri.EscapeDataString(key)}")
            .ConfigureAwait(false) ?? new DeleteResult();
}
