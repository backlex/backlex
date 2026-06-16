using Backlex;
using static Backlex.Filter;

// Quickstart tour of the .NET SDK.
//   BACKLEX_URL=http://localhost:5173 BACKLEX_KEY=pak_... dotnet run

var url = Environment.GetEnvironmentVariable("BACKLEX_URL") ?? "http://localhost:5173";
var key = Environment.GetEnvironmentVariable("BACKLEX_KEY");

var client = new BacklexClient(url, new BacklexClientOptions { ApiKey = key });

// Fluent query builder → compiles to canonical JSON (same wire format as TS/Python/Go).
var query = client.From<Dictionary<string, object?>>("posts").Query()
    .Where(And(
        Eq("published", true),
        Gte("views", 100),
        Rel("author", Eq("tier", "gold")),
        Gte("created_at", Now(sub: new Dictionary<string, int> { ["days"] = 7 }))))
    .Select("id", "title", "author.name")
    .OrderBy("-created_at")
    .Limit(10)
    .WithMeta("filter_count");

try
{
    var res = await query.ListAsync();
    Console.WriteLine($"got {res.Data.Count} posts (meta={(res.Meta is null ? "{}" : string.Join(",", res.Meta))})");
}
catch (BacklexException e)
{
    Console.WriteLine($"list failed: {e.Status} {e.Code} — {e.Message}");
}

// CRUD
// var created = await client.From<Dictionary<string, object?>>("posts")
//     .CreateAsync(new Dictionary<string, object?> { ["title"] = "Hello" });

// Realtime (SSE on a background task)
// using var sub = client.Subscribe<Dictionary<string, object?>>(
//     "items:posts", ev => Console.WriteLine($"event: {ev.Event}"));
