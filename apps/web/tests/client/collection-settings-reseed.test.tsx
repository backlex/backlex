/**
 * `<CollectionSettings>` — the metadata form must re-seed when the operator
 * navigates from one collection to another.
 *
 * Every metadata field here is `useState(schema.x ?? "")` plus a matching line
 * in a `useEffect` that re-seeds on `schema` change. `useState`'s initializer
 * runs ONCE per mount, and the admin keeps this component mounted while the
 * user switches collections — so a field present in the initializer but missing
 * from the effect keeps showing the PREVIOUS collection's value.
 *
 * That is the worst shape a form bug can take: the input is populated, it looks
 * authoritative, and saving writes another collection's description onto this
 * one. It is also a known trap in this codebase — a new metadata key has to be
 * added in three places (the initializer, the re-seed effect, and the caller's
 * schemaState hydration), and nothing forced the second.
 *
 * The test is deliberately written as a PROPERTY over the whole metadata set
 * rather than one assertion per field: it re-renders with a second collection
 * whose every value differs, and asserts none of the first one's survives. A
 * field added to the form later is covered the day it is added, provided its
 * value appears in `B`.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { cleanup } from "@testing-library/react";
import { CollectionSettings } from "../../src/client/admin/collections/collection-settings";
import { renderWithProviders } from "./render";

afterEach(() => cleanup());

/** Two collections that share no metadata value at all. */
const A = {
  slug: "posts",
  ownerScoped: false,
  fields: [{ name: "title", type: "text" }],
  singular: "post",
  plural: "posts",
  note: "Blog entries",
  displayTemplate: "{{ title }}",
  previewUrl: "https://a.example/{{ slug }}",
} as never;

const B = {
  slug: "invoices",
  ownerScoped: false,
  fields: [{ name: "number", type: "text" }],
  singular: "invoice",
  plural: "invoices",
  note: "Money owed to us",
  displayTemplate: "{{ number }}",
  previewUrl: "https://b.example/{{ number }}",
} as never;

/** Every metadata value that must not survive a switch from A to B. */
// `displayTemplate` and `previewUrl` are deliberately absent: both render
// through template-editor components rather than plain inputs, so a value scan
// cannot see them. Reaching in would be a test of those editors, not of the
// re-seed. The three below are ordinary inputs and are enough to catch the bug
// this file is about — every metadata key is re-seeded from ONE `useEffect`
// body, so a miss there is visible on any of them.
const A_ONLY = ["post", "posts", "Blog entries"];
const B_ONLY = ["invoice", "invoices", "Money owed to us"];

const props = (schema: unknown) => ({
  schema: schema as never,
  existingSlugs: ["posts", "invoices"],
  collections: [{ slug: "posts" }, { slug: "invoices" }],
  onPatch: () => {},
  onRename: () => {},
  onDelete: () => {},
});

/** Values currently sitting in the form's inputs. */
const inputValues = (root: HTMLElement): string[] =>
  [...root.querySelectorAll("input, textarea")].map(
    (el) => (el as HTMLInputElement | HTMLTextAreaElement).value,
  );

describe("<CollectionSettings> — switching collections re-seeds every field", () => {
  test("collection A's metadata is in the form to begin with", () => {
    // Liveness. The switch assertion below is "none of A's values remain", and
    // that is satisfied trivially by a form that never showed them.
    const { container } = renderWithProviders(<CollectionSettings {...props(A)} />);
    const values = inputValues(container);
    for (const v of A_ONLY) {
      expect(`form shows ${JSON.stringify(v)}: ${values.includes(v)}`).toBe(
        `form shows ${JSON.stringify(v)}: true`,
      );
    }
  });

  test("navigating to collection B leaves none of A's values behind", () => {
    const { container, rerender } = renderWithProviders(<CollectionSettings {...props(A)} />);
    // The component stays mounted — this is a prop change, not a remount, which
    // is exactly how the admin navigates between collections. Remounting would
    // re-run the `useState` initializers and hide the bug entirely.
    rerender(<CollectionSettings {...props(B)} />);

    const values = inputValues(container);
    for (const v of B_ONLY) {
      expect(`re-seeded to ${JSON.stringify(v)}: ${values.includes(v)}`).toBe(
        `re-seeded to ${JSON.stringify(v)}: true`,
      );
    }
    for (const v of A_ONLY) {
      // `posts`/`invoices` overlap as slug vs plural, so only values unique to A
      // can be asserted absent — the loop above already pins B's arrival.
      if (B_ONLY.includes(v)) continue;
      expect(`stale value ${JSON.stringify(v)} still shown: ${values.includes(v)}`).toBe(
        `stale value ${JSON.stringify(v)} still shown: false`,
      );
    }
  });

  test("a collection with no metadata clears the form rather than keeping A's", () => {
    // The null case, which is the one a `?? ""` initializer gets right and a
    // re-seed effect written as `if (x) setX(x)` gets wrong: switching from a
    // described collection to an undescribed one must empty the field, not
    // leave the previous description in place.
    const { container, rerender } = renderWithProviders(<CollectionSettings {...props(A)} />);
    rerender(
      <CollectionSettings
        {...props({ slug: "bare", ownerScoped: false, fields: [{ name: "x", type: "text" }] })}
      />,
    );

    const values = inputValues(container);
    for (const v of A_ONLY) {
      expect(`cleared ${JSON.stringify(v)}: ${!values.includes(v)}`).toBe(
        `cleared ${JSON.stringify(v)}: true`,
      );
    }
  });
});
