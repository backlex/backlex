# frozen_string_literal: true

Gem::Specification.new do |s|
  s.name        = "backlex"
  s.version     = "0.0.1"
  s.summary     = "Official Ruby client for the backlex API (CRUD, query builder, auth, realtime, storage)."
  s.description = "A thin, typed wrapper over the backlex REST + SSE API. Zero runtime dependencies (stdlib net/http + json)."
  s.authors     = ["backlex"]
  s.homepage    = "https://backlex.com"
  s.license     = "MIT"
  s.files       = Dir["lib/**/*.rb"] + ["README.md"]
  s.require_paths = ["lib"]
  s.required_ruby_version = ">= 2.6"
  s.metadata = { "documentation_uri" => "https://backlex.com/docs/sdk-and-cli" }
end
