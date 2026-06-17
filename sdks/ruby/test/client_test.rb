# frozen_string_literal: true

require "minitest/autorun"
require "webrick"
require "json"
require "uri"
require_relative "../lib/backlex"

# HTTP-layer tests backed by an in-process WEBrick server — the Ruby equivalent
# of the Python MockTransport / .NET RecordingHandler tests.
class ClientTest < Minitest::Test
  F = Backlex::Filter

  # Overriding #service (not do_GET/do_POST) lets one servlet capture every HTTP
  # method, including PATCH/PUT/DELETE which mount_proc rejects with 405.
  class RecordingServlet < WEBrick::HTTPServlet::AbstractServlet
    def initialize(server, last)
      super(server)
      @last = last
    end

    def service(req, res)
      @last[:method] = req.request_method
      @last[:path] = req.path
      @last[:query] = req.query_string
      @last[:auth] = req["Authorization"]
      @last[:body] = req.body
      code, json = ClientTest.route(@last)
      res.status = code
      res["Content-Type"] = "application/json"
      res.body = json
    end
  end

  def setup
    @last = {}
    @server = WEBrick::HTTPServer.new(
      Port: 0, BindAddress: "127.0.0.1",
      Logger: WEBrick::Log.new(File::NULL), AccessLog: []
    )
    @server.mount("/", RecordingServlet, @last)
    @port = @server.listeners.first.addr[1]
    @thread = Thread.new { @server.start }
    @base = "http://127.0.0.1:#{@port}"
  end

  def teardown
    @server.shutdown
    @thread.join
  end

  def self.route(last)
    return [404, '{"error":{"code":"NOT_FOUND","message":"no such collection"}}'] if last[:path] == "/api/items/missing"

    if last[:method] == "POST" && last[:path].end_with?("/sign-in/email")
      return last[:path].start_with?("/api/t/") ?
        [200, '{"user":{"id":"u1","email":"a@b.c"},"token":"tok_123"}'] :
        [200, '{"user":{"id":"u1","email":"a@b.c"}}']
    end
    return [200, '{"ok":true}'] if last[:method] == "DELETE"
    return [200, '{"data":{"id":"x1"}}'] if %w[POST PATCH].include?(last[:method])

    [200, '{"data":[],"limit":50,"offset":0}']
  end

  def filter_param
    pair = @last[:query].split("&").find { |p| p.start_with?("filter=") }
    URI.decode_www_form_component(pair.split("=", 2)[1])
  end

  def test_query_string_filter_is_not_double_encoded
    client = Backlex::Client.new(@base, api_key: "pak_x")
    client.from("orders").query.where(F.eq("status", "active")).order_by("-created_at").limit(5).list

    assert_equal "GET", @last[:method]
    assert_equal "/api/items/orders", @last[:path]
    # If double percent-encoded, JSON.parse would raise.
    assert_equal({ "status" => { "_eq" => "active" } }, JSON.parse(filter_param))
  end

  def test_api_key_bearer_header
    client = Backlex::Client.new(@base, api_key: "pak_secret")
    client.from("posts").list
    assert_equal "Bearer pak_secret", @last[:auth]
  end

  def test_crud_methods_paths_and_body
    client = Backlex::Client.new(@base, api_key: "pak_x")
    posts = client.from("posts")

    posts.create({ "title" => "Hi" })
    assert_equal "POST", @last[:method]
    assert_equal "/api/items/posts", @last[:path]
    assert_equal "Hi", JSON.parse(@last[:body])["title"]

    posts.update("p1", { "title" => "Edit" })
    assert_equal "PATCH", @last[:method]
    assert_equal "/api/items/posts/p1", @last[:path]

    del = posts.delete("p1")
    assert_equal "DELETE", @last[:method]
    assert_equal true, del["ok"]
  end

  def test_app_mode_token_capture_and_replay
    client = Backlex::Client.new(@base, workspace: "myapp")

    res = client.auth.sign_in("a@b.c", "pw")
    assert_equal "/api/t/myapp/auth/sign-in/email", @last[:path]
    assert_equal "tok_123", res["token"]
    assert_equal "tok_123", client.auth.token

    client.from("posts").list
    assert_equal "Bearer tok_123", @last[:auth]

    client.auth.sign_out
    assert_nil client.auth.token
  end

  def test_error_envelope_becomes_error
    client = Backlex::Client.new(@base, api_key: "pak_x")
    e = assert_raises(Backlex::Error) { client.from("missing").list }
    assert_equal 404, e.status
    assert_equal "NOT_FOUND", e.code
    assert_equal "no such collection", e.message
  end

  def test_control_plane_auth_does_not_capture_token
    client = Backlex::Client.new(@base)
    client.auth.sign_in("a@b.c", "pw")
    assert_equal "/api/auth/sign-in/email", @last[:path]
    assert_nil client.auth.token
  end
end
