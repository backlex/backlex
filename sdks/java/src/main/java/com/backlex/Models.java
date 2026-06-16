package com.backlex;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Small response POJOs grouped as nested static classes (Java allows only one
 * public top-level class per file; these are deserialized by field). The wire
 * field names match the field names here, so no annotations are needed.
 */
public final class Models {

    private Models() {
    }

    /** The authenticated principal returned by sign-in/up. */
    public static class AuthUser {
        public String id;
        public String email;
        public String name;
        public String image;
    }

    /** The sign-in/up envelope. {@code token} is only set in app mode. */
    public static class AuthResult {
        public AuthUser user = new AuthUser();
        public String token;
    }

    /** The {@code {"ok": true}} envelope returned by delete endpoints. */
    public static class DeleteResult {
        public boolean ok;
    }

    /** Describes one stored object. */
    public static class FileRow {
        public String key;
        public long size;
        public String contentType;
        public String ownerId;
        public String uploadedAt;
    }

    /** One enabled sign-in method in the public auth surface. */
    public static class AuthProvider {
        public String id;
        public String kind;
        public String label;
        public boolean enabled;
    }

    /** The public description of a workspace's auth (no secrets). */
    public static class AuthSurface {
        public String tenantId;
        public List<AuthProvider> providers = new ArrayList<>();
        public Map<String, Object> policy = new LinkedHashMap<>();
    }

    /** The {@code {"url","redirect"}} envelope from signInSocial. */
    public static class SocialResult {
        public String url;
        public boolean redirect;
    }
}
