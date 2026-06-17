part of backlex;

/// Auth surface. In app mode (workspace set) calls target that workspace's own
/// auth pool (`/api/t/<slug>/auth/...`); otherwise the control plane.
class Auth {
  final Client _client;

  Auth(this._client);

  bool get _workspaceSet => _client.workspace != null && _client.workspace!.isNotEmpty;

  String get _base => _workspaceSet
      ? '/api/t/${Uri.encodeComponent(_client.workspace!)}/auth'
      : '/api/auth';

  Map<String, dynamic> _capture(Map<String, dynamic> r) {
    if (_workspaceSet && r['token'] != null) _client.appToken = r['token'] as String;
    return r;
  }

  /// Sign up with email + password. Pass `name: null` to omit it.
  Future<Map<String, dynamic>> signUp(String email, String password, {String? name}) async {
    final body = <String, dynamic>{'email': email, 'password': password};
    if (name != null) body['name'] = name;
    return _capture(await _client.request('POST', '$_base/sign-up/email', body) as Map<String, dynamic>);
  }

  Future<Map<String, dynamic>> signIn(String email, String password) async {
    final r = await _client.request('POST', '$_base/sign-in/email', {'email': email, 'password': password});
    return _capture(r as Map<String, dynamic>);
  }

  /// Begin an OAuth sign-in; navigate the user to the returned URL.
  Future<Map<String, dynamic>> signInSocial(String provider,
      {String? callbackUrl, String? errorCallbackUrl}) async {
    final body = <String, dynamic>{'provider': provider, 'disableRedirect': true};
    if (callbackUrl != null) body['callbackURL'] = callbackUrl;
    if (errorCallbackUrl != null) body['errorCallbackURL'] = errorCallbackUrl;
    return await _client.request('POST', '$_base/sign-in/social', body) as Map<String, dynamic>;
  }

  /// Send a one-time sign-in link by email.
  Future<Map<String, dynamic>> signInMagicLink(String email, {String? callbackUrl}) async {
    final body = <String, dynamic>{'email': email};
    if (callbackUrl != null) body['callbackURL'] = callbackUrl;
    return await _client.request('POST', '$_base/sign-in/magic-link', body) as Map<String, dynamic>;
  }

  /// Email a one-time numeric code (requires the email-otp provider). [type] is
  /// `"sign-in"` (default), `"email-verification"` or `"forget-password"`.
  /// Complete a sign-in with [signInEmailOtp].
  Future<Map<String, dynamic>> sendVerificationOtp(String email, {String type = 'sign-in'}) async =>
      await _client.request('POST', '$_base/email-otp/send-verification-otp',
          {'email': email, 'type': type}) as Map<String, dynamic>;

  /// Complete an email-OTP sign-in with the code from [sendVerificationOtp]. In
  /// app mode the returned session token is captured.
  Future<Map<String, dynamic>> signInEmailOtp(String email, String otp) async {
    final r = await _client.request('POST', '$_base/sign-in/email-otp', {'email': email, 'otp': otp});
    return _capture(r as Map<String, dynamic>);
  }

  /// Send a password-reset email. `redirectTo` is the link target.
  Future<Map<String, dynamic>> requestPasswordReset(String email, {String? redirectTo}) async {
    final body = <String, dynamic>{'email': email};
    if (redirectTo != null) body['redirectTo'] = redirectTo;
    return await _client.request('POST', '$_base/request-password-reset', body) as Map<String, dynamic>;
  }

  /// Complete a reset with the token from the email and a new password.
  Future<Map<String, dynamic>> resetPassword(String newPassword, String token) async =>
      await _client.request('POST', '$_base/reset-password',
          {'newPassword': newPassword, 'token': token}) as Map<String, dynamic>;

  /// Mint a fresh access JWT from the stored session token (app mode).
  Future<Map<String, dynamic>> refresh() async =>
      await _client.request('POST', '$_base/token/refresh',
          {'refreshToken': _client.appToken}) as Map<String, dynamic>;

  /// Change the signed-in user's password (requires the current password).
  Future<Map<String, dynamic>> changePassword(String newPassword, String currentPassword,
      {bool revokeOtherSessions = false}) async =>
      await _client.request('POST', '$_base/change-password', {
        'newPassword': newPassword,
        'currentPassword': currentPassword,
        'revokeOtherSessions': revokeOtherSessions,
      }) as Map<String, dynamic>;

  /// Update the signed-in user's profile (e.g. name / image).
  Future<Map<String, dynamic>> updateUser(Map<String, dynamic> attributes) async =>
      await _client.request('POST', '$_base/update-user', attributes) as Map<String, dynamic>;

  /// Send an email-verification link.
  Future<Map<String, dynamic>> sendVerificationEmail(String email, {String? callbackUrl}) async {
    final body = <String, dynamic>{'email': email};
    if (callbackUrl != null) body['callbackURL'] = callbackUrl;
    return await _client.request('POST', '$_base/send-verification-email', body) as Map<String, dynamic>;
  }

  /// Clear the session; in app mode also drops the captured token.
  Future<void> signOut() async {
    await _client.request('POST', '$_base/sign-out');
    if (_workspaceSet) _client.appToken = null;
  }

  /// Current session payload, or `{'user': null}`.
  Future<Map<String, dynamic>> session() async =>
      await _client.request('GET', '$_base/get-session') as Map<String, dynamic>;

  /// List the signed-in user's active sessions (one row per device/login).
  Future<List<dynamic>> listSessions() async =>
      await _client.request('GET', '$_base/list-sessions') as List<dynamic>;

  /// Revoke one session by its [token] (from [listSessions]).
  Future<Map<String, dynamic>> revokeSession(String token) async =>
      await _client.request('POST', '$_base/revoke-session', {'token': token}) as Map<String, dynamic>;

  /// Revoke every session except the current one (sign out other devices).
  Future<Map<String, dynamic>> revokeOtherSessions() async =>
      await _client.request('POST', '$_base/revoke-other-sessions') as Map<String, dynamic>;

  /// Revoke all sessions, including the current one.
  Future<Map<String, dynamic>> revokeSessions() async =>
      await _client.request('POST', '$_base/revoke-sessions') as Map<String, dynamic>;

  /// Public auth surface (provider list + policy flags).
  Future<Map<String, dynamic>> providers() async {
    final r = await _client.request('GET', '$_base/providers') as Map<String, dynamic>;
    return r['data'] as Map<String, dynamic>;
  }

  /// Current workspace session token (app mode); persist and restore via `Client(token:)`.
  String? get token => _client.appToken;

  /// Restore a workspace session token (app mode).
  set token(String? value) => _client.appToken = value;
}
