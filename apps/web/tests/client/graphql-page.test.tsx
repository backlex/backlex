import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, screen, waitFor } from "@testing-library/react";
import { GraphqlPage } from "../../src/client/pages/graphql";
import { renderWithProviders } from "./render";

// Regression coverage for the "error toast on GraphQL page open" bug.
//
// Why the ~600 server specs never caught it: the GraphQL *API* introspection
// works fine (those specs exercise the route directly). The bug lived purely in
// the *client* — `loadSchema()` parsed the response as a GraphQL
// `{ data, errors }` payload and, on any non-2xx, fell through to the
// misleading "Introspection response missing __schema." instead of surfacing
// the server's AppError envelope `{ error: { code, message } }`. Only a render
// test that mounts the page with a failing fetch reaches that path — there was
// no such test, so it shipped. This is that test.
describe("<GraphqlPage> introspection error handling", () => {
  const realFetch = global.fetch;
  afterEach(() => {
    cleanup();
    global.fetch = realFetch;
  });

  test("surfaces the server's AppError message, not the generic __schema fallback", async () => {
    // The worker error middleware returns this shape (HTTP 401) when the
    // GraphQL route throws `AppError("UNAUTHORIZED", "Active tenant required")`.
    global.fetch = mock(async () =>
      new Response(
        JSON.stringify({
          error: { code: "UNAUTHORIZED", message: "Active tenant required" },
          requestId: "req_test",
        }),
        { status: 401, headers: { "content-type": "application/json" } },
      ),
    ) as unknown as typeof fetch;

    renderWithProviders(<GraphqlPage />);

    await waitFor(() => {
      expect(screen.getByText("Active tenant required")).toBeTruthy();
    });
    // The old code path would have shown this instead — assert it does NOT.
    expect(screen.queryByText(/missing __schema/i)).toBeNull();
  });

  test("surfaces a non-JSON / HTTP error response", async () => {
    global.fetch = mock(async () =>
      new Response("<html>502 Bad Gateway</html>", {
        status: 502,
        headers: { "content-type": "text/html" },
      }),
    ) as unknown as typeof fetch;

    renderWithProviders(<GraphqlPage />);

    await waitFor(() => {
      expect(screen.getByText(/HTTP 502/)).toBeTruthy();
    });
  });
});
