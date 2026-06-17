package backlex

import "net/url"

// Auth is the auth surface. In app mode (WithWorkspace), calls target that
// workspace's own auth pool (/api/t/<slug>/auth/*); otherwise the control plane.
type Auth struct {
	client *Client
}

func (a *Auth) base() string {
	if a.client.workspace != "" {
		return "/api/t/" + url.PathEscape(a.client.workspace) + "/auth"
	}
	return "/api/auth"
}

func (a *Auth) capture(r *AuthResult) {
	if a.client.workspace != "" && r.Token != "" {
		a.client.appToken = r.Token
	}
}

// SignUp creates an account. In app mode this is a workspace end-user. Pass
// name="" to omit it.
func (a *Auth) SignUp(email, password, name string) (*AuthResult, error) {
	body := map[string]any{"email": email, "password": password}
	if name != "" {
		body["name"] = name
	}
	var out AuthResult
	if err := a.client.Do("POST", a.base()+"/sign-up/email", body, &out); err != nil {
		return nil, err
	}
	a.capture(&out)
	return &out, nil
}

// SignIn authenticates with email + password.
func (a *Auth) SignIn(email, password string) (*AuthResult, error) {
	body := map[string]any{"email": email, "password": password}
	var out AuthResult
	if err := a.client.Do("POST", a.base()+"/sign-in/email", body, &out); err != nil {
		return nil, err
	}
	a.capture(&out)
	return &out, nil
}

// SocialResult is the {"url","redirect"} envelope from SignInSocial.
type SocialResult struct {
	URL      string `json:"url"`
	Redirect bool   `json:"redirect"`
}

// SignInSocial begins an OAuth sign-in; navigate the user to the returned URL.
// Pass callbackURL/errorCallbackURL="" to omit.
func (a *Auth) SignInSocial(provider, callbackURL, errorCallbackURL string) (*SocialResult, error) {
	body := map[string]any{"provider": provider, "disableRedirect": true}
	if callbackURL != "" {
		body["callbackURL"] = callbackURL
	}
	if errorCallbackURL != "" {
		body["errorCallbackURL"] = errorCallbackURL
	}
	var out SocialResult
	if err := a.client.Do("POST", a.base()+"/sign-in/social", body, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// SignInMagicLink sends a one-time sign-in link by email.
func (a *Auth) SignInMagicLink(email, callbackURL string) (map[string]any, error) {
	body := map[string]any{"email": email}
	if callbackURL != "" {
		body["callbackURL"] = callbackURL
	}
	var out map[string]any
	if err := a.client.Do("POST", a.base()+"/sign-in/magic-link", body, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// RequestPasswordReset sends a password-reset email. Pass redirectTo="" to omit.
func (a *Auth) RequestPasswordReset(email, redirectTo string) (map[string]any, error) {
	body := map[string]any{"email": email}
	if redirectTo != "" {
		body["redirectTo"] = redirectTo
	}
	var out map[string]any
	if err := a.client.Do("POST", a.base()+"/request-password-reset", body, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// ResetPassword completes a reset with the token from the email and a new password.
func (a *Auth) ResetPassword(newPassword, token string) (map[string]any, error) {
	body := map[string]any{"newPassword": newPassword, "token": token}
	var out map[string]any
	if err := a.client.Do("POST", a.base()+"/reset-password", body, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// Refresh mints a fresh access JWT from the stored session token (app mode).
func (a *Auth) Refresh() (map[string]any, error) {
	body := map[string]any{"refreshToken": a.client.appToken}
	var out map[string]any
	if err := a.client.Do("POST", a.base()+"/token/refresh", body, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// SignOut clears the session; in app mode it also drops the captured token.
func (a *Auth) SignOut() error {
	if err := a.client.Do("POST", a.base()+"/sign-out", nil, nil); err != nil {
		return err
	}
	if a.client.workspace != "" {
		a.client.appToken = ""
	}
	return nil
}

// Session returns the current session payload, or {"user": null}.
func (a *Auth) Session() (map[string]any, error) {
	var out map[string]any
	if err := a.client.Do("GET", a.base()+"/get-session", nil, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// AuthProvider is one enabled sign-in method in the public auth surface.
type AuthProvider struct {
	ID      string `json:"id"`
	Kind    string `json:"kind"`
	Label   string `json:"label"`
	Enabled bool   `json:"enabled"`
}

// AuthSurface is the public description of a workspace's auth (no secrets).
type AuthSurface struct {
	TenantID  *string        `json:"tenantId"`
	Providers []AuthProvider `json:"providers"`
	Policy    map[string]any `json:"policy"`
}

// Providers returns the public auth surface (provider list + policy flags).
func (a *Auth) Providers() (*AuthSurface, error) {
	var wrap struct {
		Data AuthSurface `json:"data"`
	}
	if err := a.client.Do("GET", a.base()+"/providers", nil, &wrap); err != nil {
		return nil, err
	}
	return &wrap.Data, nil
}

// Token returns the current workspace session token (app mode); persist it across
// process restarts and restore via WithToken.
func (a *Auth) Token() string { return a.client.appToken }

// SetToken restores a workspace session token (app mode).
func (a *Auth) SetToken(token string) { a.client.appToken = token }
