part of backlex;

/// The official Dart client for the backlex API — a thin wrapper over the same
/// REST + SSE surface the TypeScript SDK (@backlex/client) speaks. Three auth
/// modes: server key, workspace app mode (token capture), or cookie session.
class Client {
  final String url;
  final String? apiKey;
  final String? workspace;
  final String? tenant;
  String? appToken;
  final HttpClient _http = HttpClient();

  late final Auth auth = Auth(this);
  late final Storage storage = Storage(this);

  Client(String baseUrl, {this.apiKey, this.workspace, String? token, this.tenant})
      : url = baseUrl.endsWith('/') ? baseUrl.substring(0, baseUrl.length - 1) : baseUrl,
        appToken = token;

  /// CRUD handle for a collection.
  Collection from(String slug) => Collection(this, slug);

  void _applyAuth(HttpClientRequest req) {
    if (apiKey != null && apiKey!.isNotEmpty) {
      req.headers.set('Authorization', 'Bearer $apiKey');
    } else if (appToken != null && appToken!.isNotEmpty) {
      req.headers.set('Authorization', 'Bearer $appToken');
    }
    if (tenant != null && tenant!.isNotEmpty) {
      req.headers.set('X-Backlex-Tenant', tenant!);
    }
  }

  /// Raw escape hatch — issues a JSON request with auth headers applied.
  Future<dynamic> request(String method, String path, [dynamic body]) async {
    final uri = Uri.parse('$url$path');
    int status;
    String text;
    try {
      final req = await _http.openUrl(method, uri);
      req.headers.set('Content-Type', 'application/json');
      _applyAuth(req);
      if (body != null) req.add(utf8.encode(jsonEncode(body)));
      final res = await req.close();
      status = res.statusCode;
      text = await res.transform(utf8.decoder).join();
    } catch (e) {
      throw BacklexException(0, 'NETWORK', e.toString());
    }
    if (status < 200 || status >= 300) throw BacklexException.fromBody(status, text);
    if (status == 204 || text.isEmpty) return null;
    return jsonDecode(text);
  }

  /// Raw-body upload (storage). Returns the response body text.
  Future<String> sendRaw(String method, String path, List<int> body, String? contentType) async {
    final uri = Uri.parse('$url$path');
    int status;
    String text;
    try {
      final req = await _http.openUrl(method, uri);
      if (contentType != null) req.headers.set('Content-Type', contentType);
      _applyAuth(req);
      req.add(body);
      final res = await req.close();
      status = res.statusCode;
      text = await res.transform(utf8.decoder).join();
    } catch (e) {
      throw BacklexException(0, 'NETWORK', e.toString());
    }
    if (status < 200 || status >= 300) throw BacklexException.fromBody(status, text);
    return text;
  }

  /// Raw byte download (storage).
  Future<List<int>> downloadRaw(String path) async {
    final uri = Uri.parse('$url$path');
    try {
      final req = await _http.openUrl('GET', uri);
      _applyAuth(req);
      final res = await req.close();
      if (res.statusCode < 200 || res.statusCode >= 300) {
        final text = await res.transform(utf8.decoder).join();
        throw BacklexException.fromBody(res.statusCode, text);
      }
      final bytes = <int>[];
      await for (final chunk in res) {
        bytes.addAll(chunk);
      }
      return bytes;
    } on BacklexException {
      rethrow;
    } catch (e) {
      throw BacklexException(0, 'NETWORK', e.toString());
    }
  }

  /// Subscribe to a realtime channel (e.g. "items:posts"). Returns a
  /// [Subscription]; `cancel()` unsubscribes. The reader auto-reconnects on a
  /// dropped stream (3s back-off), replaying via Last-Event-ID. [onError] may be null.
  Subscription subscribe(
    String channel,
    void Function(Map<String, dynamic>) onEvent, [
    void Function(Object)? onError,
  ]) {
    final sub = Subscription();
    _sseLoop(channel, sub, onEvent, onError);
    return sub;
  }

  Future<void> _sseLoop(
    String channel,
    Subscription sub,
    void Function(Map<String, dynamic>) onEvent,
    void Function(Object)? onError,
  ) async {
    String? lastId;
    while (!sub._stopped) {
      try {
        final uri = Uri.parse('$url/api/realtime/$channel/subscribe');
        final req = await _http.openUrl('GET', uri);
        req.headers.set('Accept', 'text/event-stream');
        _applyAuth(req);
        if (lastId != null) req.headers.set('Last-Event-ID', lastId);
        final res = await req.close();
        if (res.statusCode != 200) {
          onError?.call(BacklexException(res.statusCode, 'UNKNOWN', 'HTTP ${res.statusCode}'));
        } else {
          final lines = res.transform(utf8.decoder).transform(const LineSplitter());
          final data = <String>[];
          await for (final line in lines) {
            if (sub._stopped) return;
            if (line.isEmpty) {
              if (data.isNotEmpty) {
                final payload = data.join('\n');
                data.clear();
                try {
                  onEvent(jsonDecode(payload) as Map<String, dynamic>);
                } catch (e) {
                  onError?.call(e);
                }
              }
            } else if (line.startsWith(':')) {
              // comment / heartbeat
            } else if (line.startsWith('id:')) {
              lastId = line.substring(3).trim();
            } else if (line.startsWith('data:')) {
              var d = line.substring(5);
              if (d.startsWith(' ')) d = d.substring(1);
              data.add(d);
            }
          }
        }
      } catch (e) {
        if (!sub._stopped) onError?.call(e);
      }
      if (sub._stopped) return;
      await Future<void>.delayed(const Duration(seconds: 3));
    }
  }

  /// Serialize a ListQuery map into a URL query string (mirrors buildSearch in
  /// index.ts). The filter is compact JSON, percent-encoded exactly once.
  static String buildSearch(Map<String, dynamic>? q) {
    if (q == null) return '';
    final parts = <String>[];
    final filter = q['filter'];
    if (filter is Map && filter.isNotEmpty) {
      parts.add('filter=${Uri.encodeQueryComponent(jsonEncode(filter))}');
    }
    final sort = (q['sort'] as List?) ?? const [];
    if (sort.isNotEmpty) parts.add('sort=${Uri.encodeQueryComponent(sort.join(','))}');
    final fields = (q['fields'] as List?) ?? const [];
    if (fields.isNotEmpty) parts.add('fields=${Uri.encodeQueryComponent(fields.join(','))}');
    final expand = (q['expand'] as List?) ?? const [];
    if (expand.isNotEmpty) parts.add('expand=${Uri.encodeQueryComponent(expand.join(','))}');
    if (q['limit'] != null) parts.add('limit=${q['limit']}');
    if (q['offset'] != null) parts.add('offset=${q['offset']}');
    if (q['meta'] != null) parts.add('meta=${Uri.encodeQueryComponent(q['meta'] as String)}');
    if (q['locale'] != null) parts.add('locale=${Uri.encodeQueryComponent(q['locale'] as String)}');
    if (q['q'] != null) parts.add('q=${Uri.encodeQueryComponent(q['q'] as String)}');
    return parts.isEmpty ? '' : '?${parts.join('&')}';
  }
}
