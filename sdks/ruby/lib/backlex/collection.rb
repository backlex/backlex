# frozen_string_literal: true

module Backlex
  # A CRUD handle for one collection. Obtain via client.from("slug").
  class Collection
    def initialize(client, slug)
      @client = client
      @slug = slug
    end

    def list(query = nil)
      @client.request("GET", "/api/items/#{@slug}#{Client.build_search(query)}")
    end

    # Fluent builder that compiles to a ListQuery.
    def query
      QueryBuilder.new(method(:list))
    end

    # Single-function aggregate (count/sum/avg/min/max), optionally grouped.
    # body = { "agg" => "sum", "field" => "price", "groupBy" => "status" }
    def aggregate(body)
      @client.request("POST", "/api/items/#{@slug}/aggregate", body)
    end

    # query may carry expand/locale, the same params the list endpoint accepts.
    def one(id, query = nil)
      @client.request("GET", "/api/items/#{@slug}/#{id}#{Client.build_search(query)}")
    end

    def create(data)
      @client.request("POST", "/api/items/#{@slug}", data)
    end

    def update(id, patch)
      @client.request("PATCH", "/api/items/#{@slug}/#{id}", patch)
    end

    def delete(id)
      @client.request("DELETE", "/api/items/#{@slug}/#{id}")
    end

    # Flip a versioned item to published.
    def publish(id)
      @client.request("POST", "/api/items/#{@slug}/#{id}/publish")
    end

    # Flip a versioned item back to draft.
    def unpublish(id)
      @client.request("POST", "/api/items/#{@slug}/#{id}/publish?unpublish=1")
    end
  end
end
