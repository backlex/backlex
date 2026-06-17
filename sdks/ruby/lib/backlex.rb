# frozen_string_literal: true

# Official Ruby client for the backlex API.
#
#   require "backlex"
#   client = Backlex::Client.new("https://api.example.com", api_key: "pak_...")
#   posts = client.from("posts").query.where(Backlex::Filter.eq("published", true)).list
module Backlex
  VERSION = "0.0.1"
end

require_relative "backlex/error"
require_relative "backlex/filter"
require_relative "backlex/query_builder"
require_relative "backlex/collection"
require_relative "backlex/auth"
require_relative "backlex/storage"
require_relative "backlex/realtime"
require_relative "backlex/client"
