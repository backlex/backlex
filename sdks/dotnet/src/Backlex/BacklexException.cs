namespace Backlex;

/// <summary>
/// A non-2xx response from the backlex API, mirroring the TS SDK's BacklexError.
/// The API returns errors as <c>{ "error": { "code", "message", "details"? } }</c>;
/// callers branch on <see cref="Status"/> / <see cref="Code"/> rather than strings.
/// </summary>
public sealed class BacklexException : Exception
{
    /// <summary>HTTP status code.</summary>
    public int Status { get; }

    /// <summary>Machine-readable code ("VALIDATION", "UNAUTHORIZED", ...); "UNKNOWN" if absent.</summary>
    public string Code { get; }

    /// <summary>Optional structured details from the error envelope.</summary>
    public object? Details { get; }

    public BacklexException(int status, string code, string message, object? details)
        : base(message)
    {
        Status = status;
        Code = code;
        Details = details;
    }
}
