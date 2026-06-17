package com.backlex;

/**
 * A non-2xx response from the backlex API (or a transport failure), mirroring the
 * TS SDK's BacklexError. The API returns errors as
 * {@code {"error": {"code","message","details"?}}}; callers branch on
 * {@link #status} / {@link #code} rather than parsing strings. Unchecked so the
 * call sites stay clean.
 */
public class BacklexException extends RuntimeException {

    /** HTTP status code (0 for transport/parse failures). */
    public final int status;

    /** Machine-readable code ("VALIDATION", "UNAUTHORIZED", ...); "UNKNOWN" if absent. */
    public final String code;

    /** Optional structured details from the error envelope. */
    public final Object details;

    public BacklexException(int status, String code, String message, Object details) {
        super(message);
        this.status = status;
        this.code = code;
        this.details = details;
    }
}
