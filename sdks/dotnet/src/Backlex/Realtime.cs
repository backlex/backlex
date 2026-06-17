using System.Text.Json;

namespace Backlex;

/// <summary>
/// SSE realtime transport, exposed as an extension so usage mirrors the TS SDK:
/// <c>client.Subscribe&lt;Post&gt;("items:posts", ev =&gt; ...)</c>. Disposing the
/// returned handle unsubscribes. The reader runs on a background task and
/// auto-reconnects on a dropped stream (3s back-off), replaying via Last-Event-ID.
/// </summary>
public static class BacklexRealtimeExtensions
{
    private static readonly TimeSpan ReconnectDelay = TimeSpan.FromSeconds(3);

    public static IDisposable Subscribe<T>(
        this BacklexClient client,
        string channel,
        Action<ItemEvent<T>> onEvent,
        Action<Exception>? onError = null)
    {
        var cts = new CancellationTokenSource();
        _ = Task.Run(() => LoopAsync(client, channel, onEvent, onError, cts.Token));
        return new Unsubscriber(cts);
    }

    private static async Task LoopAsync<T>(
        BacklexClient client,
        string channel,
        Action<ItemEvent<T>> onEvent,
        Action<Exception>? onError,
        CancellationToken ct)
    {
        var url = $"{client.Url}/api/realtime/{channel}/subscribe";
        string? lastId = null;

        while (!ct.IsCancellationRequested)
        {
            try
            {
                using var req = new HttpRequestMessage(HttpMethod.Get, url);
                req.Headers.TryAddWithoutValidation("Accept", "text/event-stream");
                client.ApplyAuth(req);
                if (lastId != null)
                    req.Headers.TryAddWithoutValidation("Last-Event-ID", lastId);

                using var resp = await client.Http
                    .SendAsync(req, HttpCompletionOption.ResponseHeadersRead, ct)
                    .ConfigureAwait(false);

                if (!resp.IsSuccessStatusCode)
                {
                    onError?.Invoke(await client.MakeError(resp).ConfigureAwait(false));
                }
                else
                {
                    await using var stream = await resp.Content.ReadAsStreamAsync(ct).ConfigureAwait(false);
                    using var reader = new StreamReader(stream);
                    var data = new List<string>();
                    string? line;
                    while (!ct.IsCancellationRequested &&
                           (line = await reader.ReadLineAsync(ct).ConfigureAwait(false)) != null)
                    {
                        if (line.Length == 0)
                        {
                            if (data.Count > 0)
                            {
                                var payload = string.Join("\n", data);
                                data.Clear();
                                try
                                {
                                    var ev = JsonSerializer.Deserialize<ItemEvent<T>>(payload, BacklexClient.Json);
                                    if (ev != null) onEvent(ev);
                                }
                                catch (JsonException ex)
                                {
                                    onError?.Invoke(ex);
                                }
                            }
                        }
                        else if (line[0] == ':')
                        {
                            // Comment / heartbeat frame.
                        }
                        else if (line.StartsWith("id:", StringComparison.Ordinal))
                        {
                            lastId = line[3..].Trim();
                        }
                        else if (line.StartsWith("data:", StringComparison.Ordinal))
                        {
                            data.Add(line[5..].TrimStart(' '));
                        }
                    }
                }
            }
            catch (OperationCanceledException)
            {
                return;
            }
            catch (Exception ex)
            {
                if (!ct.IsCancellationRequested) onError?.Invoke(ex);
            }

            try
            {
                await Task.Delay(ReconnectDelay, ct).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                return;
            }
        }
    }

    private sealed class Unsubscriber : IDisposable
    {
        private readonly CancellationTokenSource _cts;
        public Unsubscriber(CancellationTokenSource cts) => _cts = cts;

        public void Dispose()
        {
            _cts.Cancel();
            _cts.Dispose();
        }
    }
}
