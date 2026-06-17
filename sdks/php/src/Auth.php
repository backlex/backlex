<?php

declare(strict_types=1);

namespace Backlex;

/**
 * Auth surface. In app mode (workspace set) calls target that workspace's own
 * auth pool ("/api/t/<slug>/auth/..."); otherwise the control plane.
 */
final class Auth
{
    public function __construct(private Client $client)
    {
    }

    public function signUp(string $email, string $password, ?string $name = null): array
    {
        $body = ['email' => $email, 'password' => $password];
        if ($name !== null) {
            $body['name'] = $name;
        }
        return $this->capture($this->client->request('POST', $this->base() . '/sign-up/email', $body));
    }

    public function signIn(string $email, string $password): array
    {
        return $this->capture(
            $this->client->request('POST', $this->base() . '/sign-in/email', ['email' => $email, 'password' => $password])
        );
    }

    /** Begin an OAuth sign-in; navigate the user to the returned URL. */
    public function signInSocial(string $provider, ?string $callbackUrl = null, ?string $errorCallbackUrl = null): array
    {
        $body = ['provider' => $provider, 'disableRedirect' => true];
        if ($callbackUrl !== null) {
            $body['callbackURL'] = $callbackUrl;
        }
        if ($errorCallbackUrl !== null) {
            $body['errorCallbackURL'] = $errorCallbackUrl;
        }
        return $this->client->request('POST', $this->base() . '/sign-in/social', $body);
    }

    /** Send a one-time sign-in link by email. */
    public function signInMagicLink(string $email, ?string $callbackUrl = null): array
    {
        $body = ['email' => $email];
        if ($callbackUrl !== null) {
            $body['callbackURL'] = $callbackUrl;
        }
        return $this->client->request('POST', $this->base() . '/sign-in/magic-link', $body);
    }

    /** Clear the session; in app mode also drops the captured token. */
    public function signOut(): void
    {
        $this->client->request('POST', $this->base() . '/sign-out');
        if ($this->workspaceSet()) {
            $this->client->appToken = null;
        }
    }

    /** Current session payload, or ['user' => null]. */
    public function session(): array
    {
        return $this->client->request('GET', $this->base() . '/get-session');
    }

    /** Public auth surface (provider list + policy flags). */
    public function providers(): array
    {
        return $this->client->request('GET', $this->base() . '/providers')['data'];
    }

    /** Current workspace session token (app mode); persist and restore via the 'token' option. */
    public function token(): ?string
    {
        return $this->client->appToken;
    }

    /** Restore a workspace session token (app mode). */
    public function setToken(?string $token): void
    {
        $this->client->appToken = $token;
    }

    private function workspaceSet(): bool
    {
        return $this->client->workspace !== null && $this->client->workspace !== '';
    }

    private function base(): string
    {
        return $this->workspaceSet()
            ? '/api/t/' . rawurlencode($this->client->workspace) . '/auth'
            : '/api/auth';
    }

    private function capture(array $result): array
    {
        if ($this->workspaceSet() && !empty($result['token'])) {
            $this->client->appToken = $result['token'];
        }
        return $result;
    }
}
