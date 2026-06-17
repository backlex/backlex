package com.backlex;

import com.fasterxml.jackson.databind.JavaType;
import com.fasterxml.jackson.databind.type.TypeFactory;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Auth surface. In app mode (workspace set) calls target that workspace's own
 * auth pool (/api/t/&lt;slug&gt;/auth/*); otherwise the control plane.
 */
public final class Auth {

    private final BacklexClient client;
    private final JavaType authResultType;
    private final JavaType mapType;

    Auth(BacklexClient client) {
        this.client = client;
        TypeFactory tf = BacklexClient.MAPPER.getTypeFactory();
        this.authResultType = tf.constructType(Models.AuthResult.class);
        this.mapType = tf.constructMapType(LinkedHashMap.class, String.class, Object.class);
    }

    private String base() {
        if (client.workspace == null || client.workspace.isEmpty()) {
            return "/api/auth";
        }
        return "/api/t/" + URLEncoder.encode(client.workspace, StandardCharsets.UTF_8) + "/auth";
    }

    private Models.AuthResult capture(Models.AuthResult r) {
        if (client.workspace != null && !client.workspace.isEmpty() && r.token != null && !r.token.isEmpty()) {
            client.appToken = r.token;
        }
        return r;
    }

    /** Sign up with email + password. Pass name=null to omit it. */
    public Models.AuthResult signUp(String email, String password, String name) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("email", email);
        body.put("password", password);
        if (name != null) body.put("name", name);
        return capture(client.request("POST", base() + "/sign-up/email", body, authResultType));
    }

    public Models.AuthResult signIn(String email, String password) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("email", email);
        body.put("password", password);
        return capture(client.request("POST", base() + "/sign-in/email", body, authResultType));
    }

    /** Begin an OAuth sign-in; navigate the user to the returned URL. */
    public Models.SocialResult signInSocial(String provider, String callbackUrl, String errorCallbackUrl) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("provider", provider);
        body.put("disableRedirect", true);
        if (callbackUrl != null) body.put("callbackURL", callbackUrl);
        if (errorCallbackUrl != null) body.put("errorCallbackURL", errorCallbackUrl);
        return client.request("POST", base() + "/sign-in/social", body,
                BacklexClient.MAPPER.getTypeFactory().constructType(Models.SocialResult.class));
    }

    /** Send a one-time sign-in link by email. */
    public Map<String, Object> signInMagicLink(String email, String callbackUrl) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("email", email);
        if (callbackUrl != null) body.put("callbackURL", callbackUrl);
        return client.request("POST", base() + "/sign-in/magic-link", body, mapType);
    }

    /** Clear the session; in app mode also drops the captured token. */
    public void signOut() {
        client.request("POST", base() + "/sign-out", null, mapType);
        if (client.workspace != null && !client.workspace.isEmpty()) {
            client.appToken = null;
        }
    }

    /** Current session payload, or {"user": null}. */
    public Map<String, Object> session() {
        return client.request("GET", base() + "/get-session", null, mapType);
    }

    /** Public auth surface (provider list + policy flags). */
    public Models.AuthSurface providers() {
        JavaType wrap = BacklexClient.MAPPER.getTypeFactory()
                .constructParametricType(ItemResponse.class, Models.AuthSurface.class);
        ItemResponse<Models.AuthSurface> r = client.request("GET", base() + "/providers", null, wrap);
        return r != null && r.data != null ? r.data : new Models.AuthSurface();
    }

    /** Current workspace session token (app mode); persist and restore via the builder. */
    public String token() {
        return client.appToken;
    }

    /** Restore a workspace session token (app mode). */
    public void setToken(String token) {
        client.appToken = token;
    }
}
