# frozen_string_literal: true

require "uri"

module Backlex
  # Auth surface. In app mode (workspace set) calls target that workspace's own
  # auth pool ("/api/t/<slug>/auth/..."); otherwise the control plane.
  class Auth
    def initialize(client)
      @client = client
    end

    def sign_up(email, password, name = nil)
      body = { "email" => email, "password" => password }
      body["name"] = name if name
      capture(@client.request("POST", "#{base}/sign-up/email", body))
    end

    def sign_in(email, password)
      capture(@client.request("POST", "#{base}/sign-in/email", { "email" => email, "password" => password }))
    end

    # Begin an OAuth sign-in; navigate the user to the returned URL.
    def sign_in_social(provider, callback_url: nil, error_callback_url: nil)
      body = { "provider" => provider, "disableRedirect" => true }
      body["callbackURL"] = callback_url if callback_url
      body["errorCallbackURL"] = error_callback_url if error_callback_url
      @client.request("POST", "#{base}/sign-in/social", body)
    end

    # Send a one-time sign-in link by email.
    def sign_in_magic_link(email, callback_url: nil)
      body = { "email" => email }
      body["callbackURL"] = callback_url if callback_url
      @client.request("POST", "#{base}/sign-in/magic-link", body)
    end

    # Email a one-time numeric code (requires the email-otp provider). +type+ is
    # "sign-in" (default), "email-verification" or "forget-password". Complete a
    # sign-in with #sign_in_email_otp.
    def send_verification_otp(email, type: "sign-in")
      @client.request("POST", "#{base}/email-otp/send-verification-otp", { "email" => email, "type" => type })
    end

    # Complete an email-OTP sign-in with the code from #send_verification_otp. In
    # app mode the returned session token is captured.
    def sign_in_email_otp(email, otp)
      capture(@client.request("POST", "#{base}/sign-in/email-otp", { "email" => email, "otp" => otp }))
    end

    # Clear the session; in app mode also drops the captured token.
    # Send a password-reset email. +redirect_to+ is the link target.
    def request_password_reset(email, redirect_to: nil)
      body = { "email" => email }
      body["redirectTo"] = redirect_to if redirect_to
      @client.request("POST", "#{base}/request-password-reset", body)
    end

    # Complete a reset with the token from the email and a new password.
    def reset_password(new_password, token)
      @client.request("POST", "#{base}/reset-password", { "newPassword" => new_password, "token" => token })
    end

    # Mint a fresh access JWT from the stored session token (app mode).
    def refresh
      @client.request("POST", "#{base}/token/refresh", { "refreshToken" => @client.app_token })
    end

    # Change the signed-in user's password (requires the current password).
    def change_password(new_password, current_password, revoke_other_sessions: false)
      @client.request("POST", "#{base}/change-password", {
                        "newPassword" => new_password,
                        "currentPassword" => current_password,
                        "revokeOtherSessions" => revoke_other_sessions
                      })
    end

    # Update the signed-in user's profile (e.g. name / image).
    def update_user(attributes)
      @client.request("POST", "#{base}/update-user", attributes)
    end

    # Send an email-verification link.
    def send_verification_email(email, callback_url: nil)
      body = { "email" => email }
      body["callbackURL"] = callback_url if callback_url
      @client.request("POST", "#{base}/send-verification-email", body)
    end

    def sign_out
      @client.request("POST", "#{base}/sign-out")
      @client.app_token = nil if workspace?
    end

    # Current session payload, or { "user" => nil }.
    def session
      @client.request("GET", "#{base}/get-session")
    end

    # List the signed-in user's active sessions (one row per device/login).
    def list_sessions
      @client.request("GET", "#{base}/list-sessions")
    end

    # Revoke one session by its +token+ (from #list_sessions).
    def revoke_session(token)
      @client.request("POST", "#{base}/revoke-session", { "token" => token })
    end

    # Revoke every session except the current one (sign out other devices).
    def revoke_other_sessions
      @client.request("POST", "#{base}/revoke-other-sessions")
    end

    # Revoke all sessions, including the current one.
    def revoke_sessions
      @client.request("POST", "#{base}/revoke-sessions")
    end

    # Public auth surface (provider list + policy flags).
    def providers
      @client.request("GET", "#{base}/providers")["data"]
    end

    # Current workspace session token (app mode); persist and restore via Client.new(token:).
    def token
      @client.app_token
    end

    # Restore a workspace session token (app mode).
    def token=(value)
      @client.app_token = value
    end

    private

    def workspace?
      !(@client.workspace.nil? || @client.workspace.empty?)
    end

    def base
      workspace? ? "/api/t/#{URI.encode_www_form_component(@client.workspace)}/auth" : "/api/auth"
    end

    def capture(result)
      @client.app_token = result["token"] if workspace? && result.is_a?(Hash) && result["token"]
      result
    end
  end
end
