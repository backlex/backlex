namespace Backlex;

/// <summary>
/// A typed CRUD handle for one collection. Obtain via <c>client.From&lt;T&gt;(slug)</c>.
/// Use <c>Dictionary&lt;string, object?&gt;</c> as T for schema-blind access, or a
/// generated/POCO type.
/// </summary>
public sealed class Collection<T>
{
    private readonly BacklexClient _client;
    private readonly string _slug;

    internal Collection(BacklexClient client, string slug)
    {
        _client = client;
        _slug = slug;
    }

    public async Task<ListResponse<T>> ListAsync(ListQuery? query = null) =>
        await _client.RequestAsync<ListResponse<T>>(
            HttpMethod.Get, $"/api/items/{_slug}{BacklexClient.BuildSearch(query)}")
            .ConfigureAwait(false) ?? new ListResponse<T>();

    /// <summary>Fluent builder that compiles to a <see cref="ListQuery"/>.</summary>
    public QueryBuilder<T> Query() => new(ListAsync);

    /// <summary>Single-function aggregate (count/sum/avg/min/max), optionally grouped.</summary>
    public async Task<AggregateResponse> AggregateAsync(object body) =>
        await _client.RequestAsync<AggregateResponse>(HttpMethod.Post, $"/api/items/{_slug}/aggregate", body)
            .ConfigureAwait(false) ?? new AggregateResponse();

    /// <summary>
    /// Fetch a single item by id. Pass an optional <see cref="ItemQuery"/> to
    /// inline relations (Expand) or project i18n_text fields (Locale).
    /// </summary>
    public async Task<ItemResponse<T>> OneAsync(string id, ItemQuery? query = null) =>
        await _client.RequestAsync<ItemResponse<T>>(
            HttpMethod.Get, $"/api/items/{_slug}/{id}{BacklexClient.BuildItemSearch(query)}")
            .ConfigureAwait(false) ?? new ItemResponse<T>();

    public async Task<ItemResponse<T>> CreateAsync(object data) =>
        await _client.RequestAsync<ItemResponse<T>>(HttpMethod.Post, $"/api/items/{_slug}", data)
            .ConfigureAwait(false) ?? new ItemResponse<T>();

    public async Task<ItemResponse<T>> UpdateAsync(string id, object patch) =>
        await _client.RequestAsync<ItemResponse<T>>(HttpMethod.Patch, $"/api/items/{_slug}/{id}", patch)
            .ConfigureAwait(false) ?? new ItemResponse<T>();

    public async Task<DeleteResult> DeleteAsync(string id) =>
        await _client.RequestAsync<DeleteResult>(HttpMethod.Delete, $"/api/items/{_slug}/{id}")
            .ConfigureAwait(false) ?? new DeleteResult();

    /// <summary>Flip a versioned item to published.</summary>
    public async Task<ItemResponse<T>> PublishAsync(string id) =>
        await _client.RequestAsync<ItemResponse<T>>(HttpMethod.Post, $"/api/items/{_slug}/{id}/publish")
            .ConfigureAwait(false) ?? new ItemResponse<T>();

    /// <summary>Flip a versioned item back to draft.</summary>
    public async Task<ItemResponse<T>> UnpublishAsync(string id) =>
        await _client.RequestAsync<ItemResponse<T>>(HttpMethod.Post, $"/api/items/{_slug}/{id}/publish?unpublish=1")
            .ConfigureAwait(false) ?? new ItemResponse<T>();
}
