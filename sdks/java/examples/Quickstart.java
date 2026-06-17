import static com.backlex.Filter.*;

import com.backlex.BacklexClient;
import com.backlex.BacklexException;
import com.backlex.ListResponse;
import java.util.Map;

/**
 * Quickstart tour of the Java SDK. Compile against the built jar + Jackson, e.g.:
 *
 *   mvn -q package
 *   CP="target/classes:$(mvn -q dependency:build-classpath -Dmdep.outputFile=/dev/stdout -q)"
 *   javac -cp "$CP" -d /tmp/ex examples/Quickstart.java
 *   BACKLEX_URL=http://localhost:5173 java -cp "$CP:/tmp/ex" Quickstart
 */
public class Quickstart {
    public static void main(String[] args) {
        String url = System.getenv().getOrDefault("BACKLEX_URL", "http://localhost:5173");
        String key = System.getenv("BACKLEX_KEY");

        BacklexClient client = BacklexClient.builder(url).apiKey(key).build();

        // Fluent query builder → compiles to canonical JSON (same wire format as TS/Python/Go/.NET).
        var query = client.from("posts", Object.class).query()
                .where(and(
                        eq("published", true),
                        gte("views", 100),
                        rel("author", eq("tier", "gold")),
                        gte("created_at", now(null, Map.of("days", 7)))))
                .select("id", "title", "author.name")
                .orderBy("-created_at")
                .limit(10)
                .withMeta("filter_count");

        try {
            ListResponse<Object> res = query.list();
            System.out.println("got " + res.data.size() + " posts (meta=" + res.meta + ")");
        } catch (BacklexException e) {
            System.out.println("list failed: " + e.status + " " + e.code + " — " + e.getMessage());
        }

        // CRUD
        // var created = client.from("posts", Object.class).create(Map.of("title", "Hello"));

        // Realtime (SSE on a daemon thread)
        // try (var sub = client.subscribe("items:posts", Object.class,
        //         ev -> System.out.println("event: " + ev.event), null)) {
        //     Thread.sleep(5000);
        // } catch (InterruptedException ignored) {}
    }
}
