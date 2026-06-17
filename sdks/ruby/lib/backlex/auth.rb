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

    # Clear the session; in app mode also drops the captured token.
    def sign_out
      @client.request("POST", "#{base}/sign-out")
      @client.app_token = nil if workspace?
    end

    # Current session payload, or { "user" => nil }.
    def session
      @client.request("GET", "#{base}/get-session")
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
