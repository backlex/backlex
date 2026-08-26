# frozen_string_literal: true

require "net/http"
require "securerandom"
require "uri"
require "json"

module Backlex
  # The official Ruby client for the backlex API — a thin, typed wrapper over the
  # same REST + SSE surface the TypeScript SDK (@backlex/client) speaks. Three auth
  # modes: server key, workspace app mode (token capture), or cookie session.
  class Client
    attr_reader :workspace
    attr_accessor :app_token

    # Act inside a specific organization (slug or id) from here on, so `$org.id`
    # in permission rules resolves without threading it through every call.
    attr_accessor :org

    def initialize(url, api_key: nil, workspace: nil, token: nil, tenant: nil, org: nil, tracing: true)
      @url = url.chomp("/")
      @api_key = api_key
      @workspace = workspace
      @app_token = token
      @tenant = tenant
      @org = org
      @tracing = tracing
    end

    # A W3C traceparent: 00-<32-hex trace id>-<16-hex span id>-01. Mirrors
    # packages/client/src/trace.ts, which is what the API parses. Fresh per
    # request — a span id reused across calls collapses them into one span.
    def self.make_traceparent
      "00-#{SecureRandom.hex(16)}-#{SecureRandom.hex(8)}-01"
    end

    # CRUD handle for a collection.
    def from(slug)
      Collection.new(self, slug)
    end

    def auth
      @auth ||= Auth.new(self)
    end

    def storage
      @storage ||= Storage.new(self)
    end

    # Subscribe to a realtime channel (e.g. "items:posts"). Returns a Subscription;
    # #close unsubscribes. on_error may be nil.
    def subscribe(channel, on_event, on_error = nil)
      Subscription.new(self, "#{@url}/api/realtime/#{channel}/subscribe", on_event, on_error)
    end

    # Raw escape hatch — issues a JSON request with auth headers applied.
    def request(method, path, body = nil)
      uri = URI(@url + path)
      req = build_request(method, uri)
      req["Content-Type"] = "application/json"
      req.body = JSON.generate(body) unless body.nil?
      auth_header(req)
      res = send_request(uri, req)
      code = res.code.to_i
      raise Backlex::Error.from(code, res.body) if code < 200 || code >= 300
      return nil if code == 204 || res.body.nil? || res.body.empty?

      JSON.parse(res.body)
    end

    # Raw-body upload (storage). Returns the parsed JSON response.
    def put_raw(path, body, content_type)
      uri = URI(@url + path)
      req = Net::HTTP::Put.new(uri)
      req["Content-Type"] = content_type if content_type
      req.body = body
      auth_header(req)
      res = send_request(uri, req)
      code = res.code.to_i
      raise Backlex::Error.from(code, res.body) if code < 200 || code >= 300

      res.body.nil? || res.body.empty? ? nil : JSON.parse(res.body)
    end

    # Raw byte download (storage). Returns the response body string.
    def get_raw(path)
      uri = URI(@url + path)
      req = Net::HTTP::Get.new(uri)
      auth_header(req)
      res = send_request(uri, req)
      code = res.code.to_i
      raise Backlex::Error.new(code, "UNKNOWN", "HTTP #{code}") if code < 200 || code >= 300

      res.body
    end

    # The one chokepoint every request path goes through (data, storage,
    # realtime) — a header added here reaches every call.
    def auth_header(req)
      if @api_key
        req["Authorization"] = "Bearer #{@api_key}"
      elsif @app_token
        req["Authorization"] = "Bearer #{@app_token}"
      end
      req["X-Backlex-Tenant"] = @tenant if @tenant
      req["X-Backlex-Org"] = @org if @org
      # Without this a call never appears in the admin Traces panel and cannot
      # be stitched to the server spans it triggers.
      req["traceparent"] = self.class.make_traceparent if @tracing
    end

    # Serialize a ListQuery hash into a URL query string (mirrors buildSearch in
    # index.ts). The filter is compact JSON, percent-encoded exactly once.
    def self.build_search(query)
      return "" if query.nil?

      parts = []
      if query[:filter] && !query[:filter].empty?
        parts << "filter=#{URI.encode_www_form_component(JSON.generate(query[:filter]))}"
      end
      # sort/fields may be absent when a hand-built query (e.g. one(id, expand:)) is
      # passed rather than a full builder-produced ListQuery — default to [].
      parts << "sort=#{URI.encode_www_form_component(query[:sort].join(','))}" unless (query[:sort] || []).empty?
      parts << "fields=#{URI.encode_www_form_component(query[:fields].join(','))}" unless (query[:fields] || []).empty?
      unless (query[:expand] || []).empty?
        parts << "expand=#{URI.encode_www_form_component(query[:expand].join(','))}"
      end
      parts << "limit=#{query[:limit]}" unless query[:limit].nil?
      parts << "offset=#{query[:offset]}" unless query[:offset].nil?
      parts << "meta=#{URI.encode_www_form_component(query[:meta])}" if query[:meta]
      parts << "locale=#{URI.encode_www_form_component(query[:locale])}" if query[:locale]
      parts << "q=#{URI.encode_www_form_component(query[:q])}" if query[:q]
      parts.empty? ? "" : "?#{parts.join('&')}"
    end

    private

    def build_request(method, uri)
      case method.upcase
      when "GET"    then Net::HTTP::Get.new(uri)
      when "POST"   then Net::HTTP::Post.new(uri)
      when "PATCH"  then Net::HTTP::Patch.new(uri)
      when "PUT"    then Net::HTTP::Put.new(uri)
      when "DELETE" then Net::HTTP::Delete.new(uri)
      else raise ArgumentError, "unsupported method #{method}"
      end
    end

    def send_request(uri, req)
      http = Net::HTTP.new(uri.host, uri.port)
      http.use_ssl = uri.scheme == "https"
      http.request(req)
    rescue StandardError => e
      raise Backlex::Error.new(0, "NETWORK", e.message)
    end
  end
end
