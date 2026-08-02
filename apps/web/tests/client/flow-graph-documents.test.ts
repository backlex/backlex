/**
 * Builder ↔ runtime translation for the two document steps.
 *
 * Neither had a builder entry before this: `document.render` shipped with #28
 * as a runtime op and no palette item, and `document.sign` is new. So these
 * pin their arrival as well as the round-trip.
 *
 * The interesting field is `signers`. The inspector holds one `email:name:role`
 * per line — a repeated three-input sub-form for what is usually one address
 * would be more chrome than content — while the operation holds an array of
 * objects OR a single template string. That second form is the one to watch:
 * a lease carrying its own two tenants cannot be written out statically, and a
 * lone placeholder has to survive the round-trip untouched rather than being
 * parsed into `{ email: "{{ data.parties }}" }`.
 */
import { describe, expect, test } from "bun:test";
import { compileGraph, decompileGraph, type Graph } from "../../src/client/admin/flow-graph";

const graphWith = (type: string, config: Record<string, unknown>): Graph => ({
  nodes: [
    { id: "n1", kind: "trigger", type: "item.created", x: 0, y: 0, config: { collection: "leases", when: "" } },
    { id: "n2", kind: "action", type, x: 260, y: 0, config },
  ],
  edges: [{ from: "n1", to: "n2", branch: null }],
});

describe("document.render — compile", () => {
  test("emits the template and drops the empty write-back", () => {
    const out = compileGraph(
      graphWith("document.render", {
        templateKey: "invoice",
        filename: "invoice-{{ data.no }}",
        writeBackCollection: "",
        writeBackItemId: "{{ data.id }}",
        writeBackField: "",
      }),
    );
    expect(out.warnings).toEqual([]);
    expect(out.operations).toEqual([
      { type: "document.render", templateKey: "invoice", filename: "invoice-{{ data.no }}" },
    ]);
  });

  test("nests the three write-back fields back into one object", () => {
    const out = compileGraph(
      graphWith("document.render", {
        templateKey: "invoice",
        filename: "",
        writeBackCollection: "invoices",
        writeBackItemId: "{{ data.id }}",
        writeBackField: "pdf",
      }),
    );
    expect(out.operations[0]).toMatchObject({
      writeBack: { collection: "invoices", id: "{{ data.id }}", field: "pdf" },
    });
  });

  test("a half-specified write-back is a compile error, not a silent drop", () => {
    // A target row with no field to put the key in records nothing, and the
    // server would reject it anyway — better to say so while it is on screen.
    expect(() =>
      compileGraph(
        graphWith("document.render", {
          templateKey: "invoice",
          writeBackCollection: "invoices",
          writeBackItemId: "",
          writeBackField: "pdf",
        }),
      ),
    ).toThrow(/write-back/i);
  });

  test("no template is a compile error", () => {
    expect(() => compileGraph(graphWith("document.render", { templateKey: "" }))).toThrow(/template/i);
  });
});

describe("document.sign — compile", () => {
  const signGraph = (config: Record<string, unknown>) =>
    graphWith("document.sign", { templateKey: "lease", ...config });

  test("parses one signer per line into objects", () => {
    const out = compileGraph(
      signGraph({ signers: "tenant@example.com:Ayşe Yılmaz:Kiracı\noffice@example.com:Acme" }),
    );
    expect(out.warnings).toEqual([]);
    expect(out.operations).toEqual([
      {
        type: "document.sign",
        templateKey: "lease",
        signers: [
          { email: "tenant@example.com", name: "Ayşe Yılmaz", role: "Kiracı" },
          { email: "office@example.com", name: "Acme" },
        ],
      },
    ]);
  });

  test("a lone placeholder is passed through, not parsed into an address", () => {
    // It resolves to a whole list at run time off a row that carries its own
    // counterparties; parsing it here would send an invitation to the literal
    // string "{{ data.parties }}".
    const out = compileGraph(signGraph({ signers: "{{ data.parties }}" }));
    expect((out.operations[0] as any).signers).toBe("{{ data.parties }}");
  });

  test("a placeholder with anything around it is still one signer line", () => {
    const out = compileGraph(signGraph({ signers: "{{ data.email }}:{{ data.name }}:Tenant" }));
    expect((out.operations[0] as any).signers).toEqual([
      { email: "{{ data.email }}", name: "{{ data.name }}", role: "Tenant" },
    ]);
  });

  test("ordering and expiry only appear when set", () => {
    const bare = compileGraph(signGraph({ signers: "a@example.com", ordered: false, expiresInDays: "" }));
    expect(bare.operations[0]).toEqual({
      type: "document.sign",
      templateKey: "lease",
      signers: [{ email: "a@example.com" }],
    });

    const full = compileGraph(
      signGraph({ signers: "a@example.com", ordered: true, expiresInDays: "14", title: "Lease {{ data.no }}" }),
    );
    expect(full.operations[0]).toMatchObject({ ordered: true, expiresInDays: 14, title: "Lease {{ data.no }}" });
  });

  test("no signers is a compile error", () => {
    expect(() => compileGraph(signGraph({ signers: "   " }))).toThrow(/signer/i);
  });
});

describe("round-trip", () => {
  const roundTrip = (type: string, config: Record<string, unknown>) => {
    const compiled = compileGraph(graphWith(type, config));
    const back = decompileGraph({
      trigger: compiled.trigger,
      operations: compiled.operations,
      layout: compiled.layout,
    });
    return back.nodes.find((n) => n.kind === "action")!.config as Record<string, unknown>;
  };

  test("document.render survives an edit", () => {
    const config = roundTrip("document.render", {
      templateKey: "invoice",
      filename: "inv",
      writeBackCollection: "invoices",
      writeBackItemId: "{{ data.id }}",
      writeBackField: "pdf",
    });
    expect(config).toMatchObject({
      templateKey: "invoice",
      filename: "inv",
      writeBackCollection: "invoices",
      writeBackItemId: "{{ data.id }}",
      writeBackField: "pdf",
    });
  });

  test("document.sign signers come back as the lines they were typed as", () => {
    const config = roundTrip("document.sign", {
      templateKey: "lease",
      signers: "a@example.com:Ayşe:Kiracı\nb@example.com",
      ordered: true,
      expiresInDays: "7",
    });
    expect(config.signers).toBe("a@example.com:Ayşe:Kiracı\nb@example.com");
    expect(config.ordered).toBe(true);
    expect(config.expiresInDays).toBe("7");
  });

  test("a templated signer list comes back as the template, not as a parsed row", () => {
    // The failure this catches is silent: re-saving would turn the whole-list
    // placeholder into a single signer whose address is that placeholder.
    const config = roundTrip("document.sign", { templateKey: "lease", signers: "{{ data.parties }}" });
    expect(config.signers).toBe("{{ data.parties }}");
  });
});
