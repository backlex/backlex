# frozen_string_literal: true

# Quickstart tour of the Ruby SDK.
#   BACKLEX_URL=http://localhost:5173 BACKLEX_KEY=pak_... ruby -Ilib examples/quickstart.rb

require_relative "../lib/backlex"

F = Backlex::Filter

url = ENV.fetch("BACKLEX_URL", "http://localhost:5173")
client = Backlex::Client.new(url, api_key: ENV["BACKLEX_KEY"])

# Fluent query builder → compiles to canonical JSON (same wire format as TS/Python/Go/.NET/Java/Swift/Kotlin).
query = client.from("posts").query
              .where(F.and_(
                       F.eq("published", true),
                       F.gte("views", 100),
                       F.rel("author", F.eq("tier", "gold")),
                       F.gte("created_at", F.now(sub: { "days" => 7 }))
                     ))
              .select("id", "title", "author.name")
              .order_by("-created_at")
              .limit(10)
              .with_meta("filter_count")

begin
  res = query.list
  puts "got #{res['data'].length} posts (meta=#{res['meta']})"
rescue Backlex::Error => e
  puts "list failed: #{e.status} #{e.code} — #{e.message}"
end

# CRUD
# created = client.from("posts").create({ "title" => "Hello" })

# Realtime (SSE on a background thread)
# sub = client.subscribe("items:posts", ->(ev) { puts "event: #{ev['event']}" })
# sleep 5
# sub.close
