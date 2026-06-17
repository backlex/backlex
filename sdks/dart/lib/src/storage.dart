part of backlex;

/// File operations against `/api/storage`.
class Storage {
  final Client _client;

  Storage(this._client);

  /// List stored objects, optionally filtered by key prefix.
  Future<List<dynamic>> list([String? prefix]) async {
    var path = '/api/storage';
    if (prefix != null && prefix.isNotEmpty) {
      path += '?prefix=${Uri.encodeQueryComponent(prefix)}';
    }
    final r = await _client.request('GET', path) as Map<String, dynamic>;
    return r['data'] as List<dynamic>;
  }

  /// Upload bytes under [key]. Pass `contentType`/`folderId` null to omit them.
  Future<Map<String, dynamic>> put(String key, List<int> body,
      {String? contentType, String? folderId}) async {
    var path = '/api/storage/${Uri.encodeComponent(key)}';
    if (folderId != null && folderId.isNotEmpty) {
      path += '?folderId=${Uri.encodeQueryComponent(folderId)}';
    }
    final text = await _client.sendRaw('PUT', path, body, contentType);
    return (text.isEmpty ? <String, dynamic>{} : jsonDecode(text)) as Map<String, dynamic>;
  }

  /// Fetch the raw bytes for [key].
  Future<List<int>> download(String key) =>
      _client.downloadRaw('/api/storage/${Uri.encodeComponent(key)}');

  /// Remove the object at [key].
  Future<Map<String, dynamic>> delete(String key) async =>
      await _client.request('DELETE', '/api/storage/${Uri.encodeComponent(key)}') as Map<String, dynamic>;
}
