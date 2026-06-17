using Xunit;
using static Backlex.Filter;

namespace Backlex.Tests;

public class QueryTests
{
    [Fact]
    public void LeafAndLogical()
    {
        var c = Normalize(And(Eq("status", "active"), Gte("total", 100)));
        JsonAssert.Equal(c, new Dictionary<string, object?>
        {
            ["$and"] = new object[]
            {
                new Dictionary<string, object?> { ["status"] = new Dictionary<string, object?> { ["_eq"] = "active" } },
                new Dictionary<string, object?> { ["total"] = new Dictionary<string, object?> { ["_gte"] = 100 } },
            },
        });
    }

    [Fact]
    public void RelationHopPrefixesKeys()
    {
        var c = Rel("customer", Eq("tier", "gold"));
        JsonAssert.Equal(c, new Dictionary<string, object?>
        {
            ["customer.tier"] = new Dictionary<string, object?> { ["_eq"] = "gold" },
        });
    }

    [Fact]
    public void RelationHopMultipleConds()
    {
        var c = Rel("customer", Eq("tier", "gold"), Gte("age", 18));
        JsonAssert.Equal(c, new Dictionary<string, object?>
        {
            ["$and"] = new object[]
            {
                new Dictionary<string, object?> { ["customer.tier"] = new Dictionary<string, object?> { ["_eq"] = "gold" } },
                new Dictionary<string, object?> { ["customer.age"] = new Dictionary<string, object?> { ["_gte"] = 18 } },
            },
        });
    }

    [Fact]
    public void NowRelativeDate()
    {
        var c = Gte("placed_at", Now(sub: new Dictionary<string, int> { ["months"] = 1 }));
        JsonAssert.Equal(c, new Dictionary<string, object?>
        {
            ["placed_at"] = new Dictionary<string, object?>
            {
                ["_gte"] = new Dictionary<string, object?>
                {
                    ["$now"] = new Dictionary<string, object?> { ["sub"] = new Dictionary<string, object?> { ["months"] = 1 } },
                },
            },
        });
    }

    [Fact]
    public void NormalizeImplicitEqualityAndAliases()
    {
        JsonAssert.Equal(
            Normalize(new Dictionary<string, object?> { ["status"] = "active" }),
            new Dictionary<string, object?> { ["status"] = new Dictionary<string, object?> { ["_eq"] = "active" } });

        JsonAssert.Equal(
            Normalize(new Dictionary<string, object?> { ["_and"] = new object[] { new Dictionary<string, object?> { ["a"] = 1 } } }),
            new Dictionary<string, object?> { ["$and"] = new object[] { new Dictionary<string, object?> { ["a"] = new Dictionary<string, object?> { ["_eq"] = 1 } } } });

        // Idempotent.
        var once = Normalize(new Dictionary<string, object?> { ["status"] = "active" });
        JsonAssert.Equal(Normalize(once), once);
    }

    [Fact]
    public void ToQueryAssembly()
    {
        var b = new BacklexClient("http://x")
            .From<Dictionary<string, object?>>("posts")
            .Query()
            .Where(Eq("published", true))
            .Select("id", "title")
            .OrderBy("-created_at", "id")
            .Limit(50)
            .Offset(10)
            .WithMeta("filter_count");
        var q = b.ToQuery();

        JsonAssert.Equal(q.Filter, new Dictionary<string, object?> { ["published"] = new Dictionary<string, object?> { ["_eq"] = true } });
        Assert.Equal(new[] { "-created_at", "id" }, q.Sort);
        Assert.Equal(50, q.Limit);
        Assert.Equal(10, q.Offset);
        Assert.Equal("filter_count", q.Meta);
    }
}
