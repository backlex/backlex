# frozen_string_literal: true

module Backlex
  # Static condition constructors — a Ruby port of the leaf/logical helpers in
  # query.ts. Compose them and pass to QueryBuilder#where. Everything compiles to
  # the canonical JSON Condition the REST API speaks.
  #
  #   rows = client.from("orders").query
  #     .where(Backlex::Filter.and_(
  #       Backlex::Filter.eq("status", "active"),
  #       Backlex::Filter.gte("total", 100),
  #       Backlex::Filter.rel("customer", Backlex::Filter.eq("tier", "gold")), # -> "customer.tier"
  #       Backlex::Filter.gte("placed_at", Backlex::Filter.now(sub: { "months" => 1 })),
  #     ))
  #     .select("id", "total", "customer.name")
  #     .order_by("-placed_at", "id")
  #     .limit(50)
  #     .list
  module Filter
    module_function

    def leaf(field, op, value)
      { field => { op => value } }
    end

    def eq(f, v); leaf(f, "_eq", v); end
    def neq(f, v); leaf(f, "_neq", v); end
    def gt(f, v); leaf(f, "_gt", v); end
    def gte(f, v); leaf(f, "_gte", v); end
    def lt(f, v); leaf(f, "_lt", v); end
    def lte(f, v); leaf(f, "_lte", v); end
    def in_(f, vs); leaf(f, "_in", vs); end
    def nin(f, vs); leaf(f, "_nin", vs); end
    def between(f, lo, hi); leaf(f, "_between", [lo, hi]); end
    def is_null(f, is_null = true); leaf(f, "_null", is_null); end
    def empty(f); leaf(f, "_empty", true); end
    def nempty(f); leaf(f, "_nempty", true); end
    def contains(f, v); leaf(f, "_contains", v); end
    def icontains(f, v); leaf(f, "_icontains", v); end
    def starts_with(f, v); leaf(f, "_starts_with", v); end
    def ends_with(f, v); leaf(f, "_ends_with", v); end

    def and_(*conds); { "$and" => conds }; end
    def or_(*conds); { "$or" => conds }; end
    def not_(cond); { "$not" => cond }; end

    # Traverse a relation one hop: every leaf key produced by +conds+ is prefixed
    # with "head.". Multiple conds are ANDed first.
    def rel(head, *conds)
      inner = conds.length == 1 ? conds[0] : { "$and" => conds }
      prefix_keys(inner, head)
    end

    # Relative-date value, e.g. Filter.now(sub: { "months" => 1 }).
    def now(add: nil, sub: nil)
      opts = {}
      opts["add"] = add if add
      opts["sub"] = sub if sub
      { "$now" => opts }
    end

    def prefix_keys(cond, head)
      return { "$and" => cond["$and"].map { |c| prefix_keys(c, head) } } if cond["$and"].is_a?(Array)
      return { "$or" => cond["$or"].map { |c| prefix_keys(c, head) } } if cond["$or"].is_a?(Array)
      return { "$not" => prefix_keys(cond["$not"], head) } if cond["$not"].is_a?(Hash)

      out = {}
      cond.each { |k, v| out["#{head}.#{k}"] = v }
      out
    end

    # Turn any accepted filter shape into the canonical Condition: handles
    # $and/$or/$not (and their _ aliases) and implicit equality
    # ({ "status" => "active" } -> { "status" => { "_eq" => "active" } }). Idempotent.
    def normalize(raw)
      return {} unless raw.is_a?(Hash)

      a = raw["$and"] || raw["_and"]
      return { "$and" => a.map { |c| normalize(c) } } if a.is_a?(Array)

      o = raw["$or"] || raw["_or"]
      return { "$or" => o.map { |c| normalize(c) } } if o.is_a?(Array)

      if raw.key?("$not") || raw.key?("_not")
        return { "$not" => normalize(raw["$not"] || raw["_not"]) }
      end

      out = {}
      raw.each do |k, v|
        out[k] =
          if v.is_a?(Hash) && comparison?(v) then v
          elsif v.is_a?(Hash) then v # unknown object shape — pass through
          else { "_eq" => v }
          end
      end
      out
    end

    def comparison?(hash)
      !hash.empty? && hash.keys.all? { |k| k.to_s.start_with?("_") }
    end
  end
end
