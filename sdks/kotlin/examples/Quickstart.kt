import com.backlex.BacklexClient
import com.backlex.BacklexException
import com.backlex.Filter

/**
 * Quickstart tour of the Kotlin SDK. Build the jar with `mvn -q package`, then
 * compile/run this against it + Jackson on the classpath.
 */
data class Post(val id: String = "", val title: String = "", val published: Boolean = false)

fun main() {
    val url = System.getenv("BACKLEX_URL") ?: "http://localhost:5173"
    val client = BacklexClient.builder(url).apiKey(System.getenv("BACKLEX_KEY")).build()

    // Fluent query builder → compiles to canonical JSON (same wire format as TS/Python/Go/.NET/Java/Swift).
    val query = client.from<Post>("posts").query()
        .where(
            Filter.and(
                Filter.eq("published", true),
                Filter.gte("views", 100),
                Filter.rel("author", Filter.eq("tier", "gold")),
                Filter.gte("created_at", Filter.now(sub = mapOf("days" to 7))),
            ),
        )
        .select("id", "title", "author.name")
        .orderBy("-created_at")
        .limit(10)
        .withMeta("filter_count")

    try {
        val res = query.list()
        println("got ${res.data.size} posts (meta=${res.meta})")
    } catch (e: BacklexException) {
        println("list failed: ${e.status} ${e.code} — ${e.message}")
    }

    // CRUD
    // val created = client.from<Post>("posts").create(mapOf("title" to "Hello"))

    // Realtime (SSE on a daemon thread)
    // client.subscribe<Post>("items:posts", { ev -> println("event: ${ev.event}") }).use {
    //     Thread.sleep(5000)
    // }
}
