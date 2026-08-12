/**
 * Hepsiburada — putting a product ON SALE, and the odd one out on every axis.
 *
 * The other three marketplaces hand back a whole tree, send an attribute's
 * values inline, and take a JSON body. This one pages the tree, needs a second
 * call per attribute, and takes a FILE. All three are absorbed inside the
 * provider, which is the strongest evidence available that the sixth shape is
 * the right size — so these tests exist to pin exactly that.
 *
 * The fourth difference shapes the code more than any of them: **the import
 * file keys on attribute NAMES and its values are value NAMES**, so this
 * provider reports a name as an attribute's id. And `FAILED` means a TECHNICAL
 * error here where it means a refusal at the other three — a word that must not
 * be translated twice.
 */
import { describe, expect, test } from "bun:test";
import {
  fetchListingAttributes,
  fetchListingCategories,
  listingFor,
  pollListingBatch,
  publishListings,
} from "@backlex/integrations";

const CONFIG = {
  merchantId: "3f0ec1a2-4c1f-4a8e-9b2e-5d6f7a8b9c0d",
  username: "user",
  password: "pass",
  environment: "test",
};
const CATALOG = "https://mpop-sit.hepsiburada.com/product";

type Call = { url: URL; method: string; headers: Record<string, string>; body?: any };

const recorder = (responses: { status?: number; body?: unknown }[] = []) => {
  const calls: Call[] = [];
  let i = 0;
  const fetchImpl = async (url: string, init?: RequestInit) => {
    calls.push({
      url: new URL(url),
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body,
    });
    const next = responses[i++] ?? {};
    return new Response(JSON.stringify(next.body ?? {}), { status: next.status ?? 200 });
  };
  return { calls, fetchImpl };
};

const publish = (products: any[], fetchImpl: any) =>
  publishListings("hepsiburada", { config: CONFIG, settings: {}, products }, fetchImpl);

const PRODUCT = (over: { product?: any; variant?: any; attributes?: any[]; categoryId?: string } = {}) => ({
  rowId: "p1",
  groupId: "p1",
  categoryId: over.categoryId ?? "80",
  fields: {
    UrunAdi: "Koşu Ayakkabısı",
    UrunAciklamasi: "<p>Hafif</p>",
    Marka: "Nike",
    images: "https://cdn.example/a.jpg",
    ...(over.product ?? {}),
  },
  variants: [
    {
      rowId: "v1",
      reference: "HB-1",
      fields: {
        merchantSku: "HB-1",
        Barcode: "8680000000001",
        price: 1299.9,
        stock: 4,
        ...(over.variant ?? {}),
      },
      // Bound by NAME, because that is what the file uses as its key.
      attributes: over.attributes ?? [{ attributeId: "renk_variant_property", valueId: "Siyah" }],
    },
  ],
});

describe("reading the listing taxonomy", () => {
  test("the tree is PAGED, and the walk stops on a short page", async () => {
    const { calls, fetchImpl } = recorder([
      {
        body: {
          data: [
            { categoryId: 1, displayName: "Ayakkabı", parentCategoryId: null, leaf: false },
            { categoryId: 80, displayName: "Koşu Ayakkabısı", parentCategoryId: 1, leaf: true },
          ],
        },
      },
    ]);

    const out = await fetchListingCategories("hepsiburada", { config: CONFIG }, fetchImpl);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url.origin + calls[0]!.url.pathname).toBe(
      `${CATALOG}/api/categories/get-all-categories`,
    );
    expect(calls[0]!.url.searchParams.get("page")).toBe("0");
    // Parents are kept on purpose: a picker has to show an operator WHERE a
    // leaf sits, not just that it is one.
    expect(out).toEqual([
      { id: "1", name: "Ayakkabı", parentId: null, leaf: false },
      { id: "80", name: "Koşu Ayakkabısı", parentId: "1", leaf: true },
    ]);
  });

  test("an attribute's values are a SECOND call, and the name is the id", async () => {
    const { calls, fetchImpl } = recorder([
      {
        body: {
          data: {
            // Dropped: these are the fixed fields already declared as columns,
            // and offering them would ask an operator to map one thing twice.
            baseAttributes: [{ name: "UrunAdi", id: "1", mandatory: true }],
            attributes: [{ name: "materyal", id: "10", mandatory: false, multiValue: false }],
            variantAttributes: [{ name: "renk_variant_property", id: "11", mandatory: true }],
          },
        },
      },
      { body: { data: [{ name: "Deri" }, { name: "Tekstil" }] } },
      { body: { data: [{ name: "Siyah" }] } },
    ]);

    const out = await fetchListingAttributes("hepsiburada", { config: CONFIG, categoryId: "80" }, fetchImpl);

    // One for the attributes, then one per attribute for its values.
    expect(calls).toHaveLength(3);
    expect(calls[1]!.url.pathname).toBe("/product/api/categories/80/attribute/10/values");
    expect(out.map((a) => a.id)).toEqual(["materyal", "renk_variant_property"]);
    expect(out[0]).toEqual({
      // The NAME, not Hepsiburada's own id — the import file keys on it.
      id: "materyal",
      name: "materyal",
      required: false,
      variant: false,
      multiple: false,
      allowCustom: false,
      values: [
        { id: "Deri", name: "Deri" },
        { id: "Tekstil", name: "Tekstil" },
      ],
    });
    expect(out[1]!.variant).toBe(true);
  });

  test("an attribute whose values cannot be read is offered as free text, not dropped", async () => {
    // A required attribute that vanished would make the category unlistable.
    const { fetchImpl } = recorder([
      { body: { data: { attributes: [{ name: "materyal", id: "10", mandatory: true }] } } },
      { status: 500 },
    ]);

    const out = await fetchListingAttributes("hepsiburada", { config: CONFIG, categoryId: "80" }, fetchImpl);

    expect(out).toHaveLength(1);
    expect(out[0]!.required).toBe(true);
    expect(out[0]!.allowCustom).toBe(true);
    expect(out[0]!.values).toEqual([]);
  });

  test("a category id that is not a number never reaches a URL", async () => {
    const { calls, fetchImpl } = recorder();
    await expect(
      fetchListingAttributes("hepsiburada", { config: CONFIG, categoryId: "80/../products" }, fetchImpl),
    ).rejects.toThrow(/numeric/);
    expect(calls).toHaveLength(0);
  });
});

describe("publishing a listing", () => {
  /** The import body is multipart; this reads the JSON part back out. */
  const filePart = async (call: Call) => {
    const form = call.body as FormData;
    const file = form.get("file") as Blob;
    return JSON.parse(await file.text());
  };

  test("sends a JSON FILE as multipart, keyed by attribute name", async () => {
    const { calls, fetchImpl } = recorder([{ body: { data: { trackingId: "track-1" } } }]);

    const out = await publish([PRODUCT()], fetchImpl);

    expect(calls[0]!.url.origin + calls[0]!.url.pathname).toBe(`${CATALOG}/api/products/import`);
    expect(calls[0]!.url.searchParams.get("version")).toBe("1");
    // Never set by hand: the boundary is generated with the body, so a
    // hand-written header would name one that is not in it.
    expect(calls[0]!.headers["Content-Type"]).toBeUndefined();

    const doc = await filePart(calls[0]!);
    expect(doc.categoryId).toBe(80);
    expect(doc.merchant).toBe(CONFIG.merchantId);
    const row = doc.attributes[0];
    expect(row.merchantSku).toBe("HB-1");
    expect(row.VaryantGroupID).toBe("p1");
    expect(row.UrunAdi).toBe("Koşu Ayakkabısı");
    expect(row.Marka).toBe("Nike");
    expect(row.Image1).toBe("https://cdn.example/a.jpg");
    // The category's own attribute, keyed by NAME with a value NAME — the whole
    // reason this provider reports names as ids.
    expect(row.renk_variant_property).toBe("Siyah");
    expect(out.batchId).toBe("track-1");
  });

  test("one file per category — a second category is left for the next run", async () => {
    // The file names its category ONCE at the top, and the engine expects one
    // ticket back, so the rest are not refused, just not in this file.
    const { calls, fetchImpl } = recorder([{ body: { data: { trackingId: "track-1" } } }]);

    const out = await publish([PRODUCT(), PRODUCT({ categoryId: "99" })], fetchImpl);

    const doc = await filePart(calls[0]!);
    expect(doc.categoryId).toBe(80);
    expect(doc.attributes).toHaveLength(1);
    expect(out.rejected ?? []).toEqual([]);
  });

  test("a unit with no merchant SKU is refused here, not by Hepsiburada", async () => {
    const { calls, fetchImpl } = recorder();
    const out = await publish([PRODUCT({ variant: { merchantSku: "" } })], fetchImpl);

    expect(calls).toHaveLength(0);
    expect(out.batchId).toBe("");
    expect(out.rejected![0]!.errors![0]).toMatch(/merchant SKU/i);
  });

  test("a 200 with no tracking id is an error, not a silent success", async () => {
    const { fetchImpl } = recorder([{ body: { data: {} } }]);
    await expect(publish([PRODUCT()], fetchImpl)).rejects.toThrow(/no tracking id/i);
  });
});

describe("reading a listing's verdict", () => {
  const poll = (body: unknown, known: string[] = ["HB-1"]) =>
    pollListingBatch(
      "hepsiburada",
      { config: CONFIG, settings: {}, batchId: "track-1", known },
      recorder([{ body }]).fetchImpl,
    );

  test("SUCCESS carries hbSku, which is the id an operator can find in the panel", async () => {
    const out = await poll({
      data: [{ merchantSku: "HB-1", hbSku: "HBV00000ABCDE", importStatus: "SUCCESS" }],
    });

    expect(out).toEqual([{ reference: "HB-1", status: "accepted", externalId: "HBV00000ABCDE" }]);
  });

  test("FAILED says it is technical and worth re-sending, without translating the word away", async () => {
    // The one place the four marketplaces use the same word for two different
    // things. The unit did not list, so it is a rejection — but the operator is
    // told what distinguishes it.
    const out = await poll({
      data: [
        {
          merchantSku: "HB-1",
          importStatus: "FAILED",
          rejectReasonsMessages: ["Görsel indirilemedi"],
        },
      ],
    });

    expect(out[0]!.status).toBe("rejected");
    expect(out[0]!.errors![0]).toBe("Görsel indirilemedi");
    expect(out[0]!.errors![1]).toMatch(/technical failure/i);
  });

  test("PROCESSING leaves the unit open", async () => {
    const out = await poll({ data: [{ merchantSku: "HB-1", importStatus: "PROCESSING" }] });
    expect(out[0]!.status).toBe("pending");
  });

  test("a tracking id that is not one never reaches a URL", async () => {
    const { calls, fetchImpl } = recorder();
    await expect(
      pollListingBatch(
        "hepsiburada",
        { config: CONFIG, settings: {}, batchId: "../categories", known: [] },
        fetchImpl,
      ),
    ).rejects.toThrow(/tracking id/i);
    expect(calls).toHaveLength(0);
  });
});

describe("the shape Hepsiburada declares", () => {
  test("the reference column is the merchant SKU and is a declared variant column", () => {
    const block = listingFor("hepsiburada")!;
    expect(block.referenceColumn).toBe("merchantSku");
    expect(block.variantColumns!.map((c) => c.value)).toContain("merchantSku");
  });
});
