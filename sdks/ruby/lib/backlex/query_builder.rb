# frozen_string_literal: true

module Backlex
  # Chainable builder that compiles to a ListQuery hash and runs it.
  class QueryBuilder
    def initialize(list_fn)
      @list_fn = list_fn
      @q = { filter: nil, sort: [], fields: [], limit: nil, offset: nil, meta: nil }
    end

    def where(cond)
      @q[:filter] = Filter.normalize(cond)
      self
    end

    # Replace the filter with a raw canonical condition (escape hatch).
    def filter(cond)
      @q[:filter] = Filter.normalize(cond)
      self
    end

    def select(*fields)
      @q[:fields].concat(fields)
      self
    end

    def order_by(*sorts)
      @q[:sort].concat(sorts)
      self
    end

    def limit(n)
      @q[:limit] = n
      self
    end

    def offset(n)
      @q[:offset] = n
      self
    end

    # Request an extra COUNT: "filter_count", "total_count", or "*".
    def with_meta(m)
      @q[:meta] = m
      self
    end

    # The assembled ListQuery hash — the canonical input the API takes.
    def to_query
      @q
    end

    def list
      @list_fn.call(@q)
    end
  end
end
