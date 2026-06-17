# frozen_string_literal: true

require "minitest/autorun"
require_relative "../lib/backlex"

class QueryTest < Minitest::Test
  F = Backlex::Filter

  def test_leaf_and_logical
    c = F.normalize(F.and_(F.eq("status", "active"), F.gte("total", 100)))
    assert_equal({ "$and" => [{ "status" => { "_eq" => "active" } }, { "total" => { "_gte" => 100 } }] }, c)
  end

  def test_relation_hop_prefixes_keys
    assert_equal({ "customer.tier" => { "_eq" => "gold" } }, F.rel("customer", F.eq("tier", "gold")))
  end

  def test_relation_hop_multiple_conds
    c = F.rel("customer", F.eq("tier", "gold"), F.gte("age", 18))
    assert_equal({ "$and" => [{ "customer.tier" => { "_eq" => "gold" } }, { "customer.age" => { "_gte" => 18 } }] }, c)
  end

  def test_now_relative_date
    c = F.gte("placed_at", F.now(sub: { "months" => 1 }))
    assert_equal({ "placed_at" => { "_gte" => { "$now" => { "sub" => { "months" => 1 } } } } }, c)
  end

  def test_normalize_implicit_equality_and_aliases
    assert_equal({ "status" => { "_eq" => "active" } }, F.normalize({ "status" => "active" }))
    assert_equal({ "$and" => [{ "a" => { "_eq" => 1 } }] }, F.normalize({ "_and" => [{ "a" => 1 }] }))
    assert_equal({ "$not" => { "a" => { "_eq" => 1 } } }, F.normalize({ "_not" => { "a" => 1 } }))

    once = F.normalize({ "status" => "active" })
    assert_equal once, F.normalize(once)
  end

  def test_to_query_assembly
    q = Backlex::Client.new("http://x").from("posts").query
                       .where(F.eq("published", true))
                       .select("id", "title")
                       .order_by("-created_at", "id")
                       .limit(50)
                       .offset(10)
                       .with_meta("filter_count")
                       .to_query

    assert_equal({ "published" => { "_eq" => true } }, q[:filter])
    assert_equal ["-created_at", "id"], q[:sort]
    assert_equal 50, q[:limit]
    assert_equal 10, q[:offset]
    assert_equal "filter_count", q[:meta]
  end
end
