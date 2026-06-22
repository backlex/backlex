/**
 * Compact, accurate API cheat-sheets for each published backlex client SDK,
 * fed to the `generate_sdk_code` MCP prompt so an agent emits *correct* SDK code
 * (real method names, real install path) instead of guessing.
 *
 * Derived from each SDK's compiling quickstart example. The query/filter grammar
 * is byte-identical across every SDK — only the surface naming differs. Keep an
 * entry in sync if its SDK's public API changes.
 */

export const SDK_LANGUAGES = [
  "typescript",
  "python",
  "go",
  "rust",
  "ruby",
  "php",
  "dart",
  "java",
  "kotlin",
  "csharp",
] as const;

export type SdkLanguage = (typeof SDK_LANGUAGES)[number];

export const SDK_REFERENCE: Record<SdkLanguage, string> = {
  typescript: `Install: npm i backlex
\`\`\`ts
import { createClient } from "backlex";
const client = createClient({ url: "BASE_URL", apiKey: "pak_..." }); // browser apps omit apiKey (cookie/session)

// Query builder (compiles to the canonical JSON filter):
const { data } = await client.from("posts").query()
  .where(f => f.and(f.eq("published", true), f.gte("views", 100), f.rel("author", a => a.eq("tier", "gold"))))
  .select("id", "title").orderBy("-created_at").limit(10).list();
// Or pass the raw query: client.from("posts").list({ filter: { published: { _eq: true } }, sort: ["-created_at"], limit: 10 });

const one = await client.from("posts").one("id", { expand: "author", locale: "en" });
await client.from("posts").create({ title: "Hi" });
await client.from("posts").update("id", { title: "Edit" });
await client.from("posts").delete("id");
await client.from("posts").aggregate({ agg: "sum", field: "views", groupBy: "author" });
// Auth (app mode): const { user } = await client.auth.signIn({ email, password });
\`\`\`
Filter helpers: f.eq/neq/lt/lte/gt/gte/in/nin/contains/between/now/and/or/not/rel.`,

  python: `Install: pip install backlex
\`\`\`python
from backlex import create_client
client = create_client("BASE_URL", api_key="pak_...")

res = (client.from_("posts").query()
       .where(lambda f: f.and_(f.eq("published", True), f.gte("views", 100), f.rel("author", lambda a: a.eq("tier", "gold"))))
       .select("id", "title").order_by("-created_at").limit(10).list())
# Or raw: client.from_("posts").list({"filter": {"published": {"_eq": True}}, "sort": ["-created_at"], "limit": 10})

one = client.from_("posts").one("id", {"expand": "author", "locale": "en"})
client.from_("posts").create({"title": "Hi"})
client.from_("posts").update("id", {"title": "Edit"})
client.from_("posts").delete("id")
client.from_("posts").aggregate({"agg": "sum", "field": "views", "groupBy": "author"})
# Auth (app mode): res = client.auth.sign_in("a@b.c", "pw")
\`\`\`
Filter helpers (lambda f): f.eq/neq/lt/lte/gt/gte/in_/nin/contains/starts_with/ends_with/is_null/now/and_/or_/not_/rel.`,

  go: `Install: go get github.com/backlex/backlex-go
\`\`\`go
import backlex "github.com/backlex/backlex-go"
client := backlex.New("BASE_URL", backlex.WithAPIKey("pak_..."))

res, err := backlex.From[map[string]any](client, "posts").Query().
    Where(backlex.And(backlex.Eq("published", true), backlex.Gte("views", 100),
        backlex.Rel("author", backlex.Eq("tier", "gold")))).
    Select("id", "title").OrderBy("-created_at").Limit(10).List()

one, _ := backlex.From[map[string]any](client, "posts").One("id", &backlex.ItemQuery{Expand: []string{"author"}})
backlex.From[map[string]any](client, "posts").Create(map[string]any{"title": "Hi"})
backlex.From[map[string]any](client, "posts").Update("id", map[string]any{"title": "Edit"})
backlex.From[map[string]any](client, "posts").Delete("id")
// Auth (app mode): res, _ := client.Auth.SignIn("a@b.c", "pw")
\`\`\`
Filter helpers: backlex.Eq/Neq/Lt/Lte/Gt/Gte/In/Nin/Contains/Between/Now/And/Or/Not/Rel. Use a generated struct instead of map[string]any for typed rows.`,

  rust: `Install: cargo add backlex serde_json
\`\`\`rust
use backlex::{filter as f, Client};
use serde_json::json;
let client = Client::builder("BASE_URL").api_key("pak_...").build();

let res = client.from("posts").query()
    .filter(f::and(vec![f::eq("published", json!(true)), f::gte("views", json!(100)),
        f::rel("author", vec![f::eq("tier", json!("gold"))])]))
    .select(&["id", "title"]).order_by(&["-created_at"]).limit(10).list()?; // returns serde_json::Value

let one = client.from("posts").one("id", Some(&backlex::ItemQuery { expand: vec!["author".into()], locale: None }))?;
client.from("posts").create(&json!({ "title": "Hi" }))?;
client.from("posts").update("id", &json!({ "title": "Edit" }))?;
client.from("posts").delete("id")?;
// Auth (app mode): let res = client.auth().sign_in("a@b.c", "pw")?;
\`\`\`
Note: the builder method is .filter(...) (not .where). Filter helpers: f::eq/neq/lt/lte/gt/gte/in_/nin/contains/now/and/or/not/rel — values are serde_json (json!()).`,

  ruby: `Install: gem install backlex
\`\`\`ruby
require "backlex"
F = Backlex::Filter
client = Backlex::Client.new("BASE_URL", api_key: "pak_...")

res = client.from("posts").query
           .where(F.and_(F.eq("published", true), F.gte("views", 100), F.rel("author", F.eq("tier", "gold"))))
           .select("id", "title").order_by("-created_at").limit(10).list

one = client.from("posts").one("id", { expand: ["author"], locale: "en" })
client.from("posts").create({ "title" => "Hi" })
client.from("posts").update("id", { "title" => "Edit" })
client.from("posts").delete("id")
# Auth (app mode): res = client.auth.sign_in("a@b.c", "pw")
\`\`\`
Filter helpers (F = Backlex::Filter): F.eq/neq/lt/lte/gt/gte/in_/nin/contains/now/and_/or_/not_/rel.`,

  php: `Install: composer require backlex/backlex
\`\`\`php
require 'vendor/autoload.php';
use Backlex\\Client;
use Backlex\\Filter as F;
$client = new Client('BASE_URL', ['api_key' => 'pak_...']);

$res = $client->from('posts')->query()
    ->where(F::and_(F::eq('published', true), F::gte('views', 100), F::rel('author', F::eq('tier', 'gold'))))
    ->select('id', 'title')->orderBy('-created_at')->limit(10)->list();

$one = $client->from('posts')->one('id', ['expand' => ['author'], 'locale' => 'en']);
$client->from('posts')->create(['title' => 'Hi']);
$client->from('posts')->update('id', ['title' => 'Edit']);
$client->from('posts')->delete('id');
// Auth (app mode): $res = $client->auth->signIn('a@b.c', 'pw');
\`\`\`
Filter helpers (Backlex\\Filter as F): F::eq/neq/lt/lte/gt/gte/in_/nin/contains/now/and_/or_/not_/rel.`,

  dart: `Install: dart pub add backlex
\`\`\`dart
import 'package:backlex/backlex.dart';
final client = Client('BASE_URL', apiKey: 'pak_...');

final res = await client.from('posts').query()
    .where(Filter.and([Filter.eq('published', true), Filter.gte('views', 100),
        Filter.rel('author', [Filter.eq('tier', 'gold')])]))
    .select(['id', 'title']).orderBy(['-created_at']).limit(10).list();

final one = await client.from('posts').one('id', {'expand': ['author'], 'locale': 'en'});
await client.from('posts').create({'title': 'Hi'});
await client.from('posts').update('id', {'title': 'Edit'});
await client.from('posts').delete('id');
// Auth (app mode): final res = await client.auth.signIn('a@b.c', 'pw');
\`\`\`
Filter helpers (Filter.*): eq/neq/lt/lte/gt/gte/inList/nin/contains/now/and/or/not/rel.`,

  java: `Install (Maven): com.backlex:backlex:0.0.1
\`\`\`java
import com.backlex.BacklexClient;
import static com.backlex.Filter.*;
import java.util.Map;
BacklexClient client = BacklexClient.builder("BASE_URL").apiKey("pak_...").build();

var res = client.from("posts", Object.class).query()
    .where(and(eq("published", true), gte("views", 100), rel("author", eq("tier", "gold"))))
    .select("id", "title").orderBy("-created_at").limit(10).list();

var one = client.from("posts", Object.class).one("id");
client.from("posts", Object.class).create(Map.of("title", "Hi"));
client.from("posts", Object.class).update("id", Map.of("title", "Edit"));
client.from("posts", Object.class).delete("id");
// Auth (app mode): var res = client.auth.signIn("a@b.c", "pw");
\`\`\`
Filter helpers (static import com.backlex.Filter.*): eq/neq/lt/lte/gt/gte/in_/nin/contains/now/and/or/not/rel.`,

  kotlin: `Install (Maven): com.backlex:backlex-kotlin:0.0.1
\`\`\`kotlin
import com.backlex.BacklexClient
import com.backlex.Filter
val client = BacklexClient.builder("BASE_URL").apiKey("pak_...").build()

val res = client.from<Any>("posts").query()
    .where(Filter.and(Filter.eq("published", true), Filter.gte("views", 100),
        Filter.rel("author", Filter.eq("tier", "gold"))))
    .select("id", "title").orderBy("-created_at").limit(10).list()

val one = client.from<Any>("posts").one("id")
client.from<Any>("posts").create(mapOf("title" to "Hi"))
client.from<Any>("posts").update("id", mapOf("title" to "Edit"))
client.from<Any>("posts").delete("id")
// Auth (app mode): val res = client.auth.signIn("a@b.c", "pw")
\`\`\`
Filter helpers (Filter.*): eq/neq/lt/lte/gt/gte/in_/nin/contains/now/and/or/not/rel.`,

  csharp: `Install: dotnet add package Backlex
\`\`\`csharp
using Backlex;
using static Backlex.Filter;
var client = new BacklexClient("BASE_URL", new BacklexClientOptions { ApiKey = "pak_..." });

var res = await client.From<Dictionary<string, object?>>("posts").Query()
    .Where(And(Eq("published", true), Gte("views", 100), Rel("author", Eq("tier", "gold"))))
    .Select("id", "title").OrderBy("-created_at").Limit(10).ListAsync();

var one = await client.From<Dictionary<string, object?>>("posts").OneAsync("id");
await client.From<Dictionary<string, object?>>("posts").CreateAsync(new Dictionary<string, object?> { ["title"] = "Hi" });
await client.From<Dictionary<string, object?>>("posts").UpdateAsync("id", new Dictionary<string, object?> { ["title"] = "Edit" });
await client.From<Dictionary<string, object?>>("posts").DeleteAsync("id");
// Auth (app mode): var res = await client.Auth.SignInAsync("a@b.c", "pw");
\`\`\`
Filter helpers (static using Backlex.Filter): Eq/Neq/Lt/Lte/Gt/Gte/In/Nin/Contains/Now/And/Or/Not/Rel.`,
};
