part of backlex;

/// A non-2xx response from the backlex API (or a transport failure), mirroring
/// the TS SDK's BacklexError. The API returns errors as
/// `{ "error": { "code", "message", "details"? } }`; callers branch on [status]
/// / [code] rather than parsing strings.
class BacklexException implements Exception {
  /// HTTP status code (0 for transport/decoding failures).
  final int status;

  /// Machine-readable code ("VALIDATION", "UNAUTHORIZED", ...); "UNKNOWN" if absent.
  final String code;
  final String message;

  /// Optional structured details from the error envelope.
  final dynamic details;

  BacklexException(this.status, this.code, this.message, [this.details]);

  /// Parse the `{ "error": {...} }` envelope from a response body.
  factory BacklexException.fromBody(int status, String? body) {
    var code = 'UNKNOWN';
    var message = 'HTTP $status';
    dynamic details;
    if (body != null && body.isNotEmpty) {
      try {
        final env = jsonDecode(body);
        if (env is Map && env['error'] is Map) {
          final err = env['error'] as Map;
          if (err['code'] != null) code = err['code'] as String;
          if (err['message'] != null) message = err['message'] as String;
          details = err['details'];
        }
      } catch (_) {
        // non-JSON error body — keep the generic message
      }
    }
    return BacklexException(status, code, message, details);
  }

  @override
  String toString() => 'BacklexException($status, $code): $message';
}
