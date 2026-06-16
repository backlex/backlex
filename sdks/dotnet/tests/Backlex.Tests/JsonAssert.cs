using System.Text.Json;
using Xunit;

namespace Backlex.Tests;

/// <summary>Order-insensitive deep JSON equality, so dictionary key order does
/// not matter when comparing canonical conditions.</summary>
internal static class JsonAssert
{
    public static void Equal(object? got, object? want)
    {
        using var g = JsonDocument.Parse(JsonSerializer.Serialize(got));
        using var w = JsonDocument.Parse(JsonSerializer.Serialize(want));
        Assert.True(
            DeepEqual(g.RootElement, w.RootElement),
            $"\n got: {JsonSerializer.Serialize(got)}\nwant: {JsonSerializer.Serialize(want)}");
    }

    private static bool DeepEqual(JsonElement a, JsonElement b)
    {
        if (a.ValueKind != b.ValueKind) return false;
        switch (a.ValueKind)
        {
            case JsonValueKind.Object:
                var ap = a.EnumerateObject().ToDictionary(p => p.Name, p => p.Value);
                var bp = b.EnumerateObject().ToDictionary(p => p.Name, p => p.Value);
                if (ap.Count != bp.Count) return false;
                foreach (var (k, v) in ap)
                    if (!bp.TryGetValue(k, out var bv) || !DeepEqual(v, bv)) return false;
                return true;
            case JsonValueKind.Array:
                var aa = a.EnumerateArray().ToList();
                var ba = b.EnumerateArray().ToList();
                if (aa.Count != ba.Count) return false;
                for (var i = 0; i < aa.Count; i++)
                    if (!DeepEqual(aa[i], ba[i])) return false;
                return true;
            default:
                return a.GetRawText() == b.GetRawText();
        }
    }
}
