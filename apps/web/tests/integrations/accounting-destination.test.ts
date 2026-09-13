/**
 * QuickBooks and Xero as DESTINATIONS — a row becomes a customer or an invoice.
 *
 * Both providers were sources first, and pushing back turns out to be a
 * different problem from pulling: neither has an upsert. A push has to FIND the
 * record and then decide create-or-update, and every assertion below is about a
 * way that decision goes wrong in a manner nobody notices until the books do
 * not balance:
 *
 *   - a second run that invoices the customer twice, because the key was not
 *     stable, or was stable but shared with another sync;
 *   - an update that REPLACES a record and quietly resets terms an accountant
 *     set by hand;
 *   - a row whose customer name carries an apostrophe, which is an ordinary
 *     name and the exact input a hand-built query breaks on;
 *   - a paid invoice that can never be modified, retried until the breaker
 *     pauses a sync over a row that is finished.
 */
import { describe, expect, test } from "bun:test";
import {
  pushToDestination,
  DESTINATION_BATCH_SIZE,
  DESTINATION_COLUMNS,
  destinationColumnsFor,
  PROVIDERS,
} from "@backlex/integrations";

interface Call {
  url: string;
  method: string;
  body: any;
}

/** A fake provider that records every call and answers from a script. */
const recorder = (responses: { status?: number; body?: unknown }[] = []) => {
  const calls: Call[] = [];
  let i = 0;
  const fetchImpl = async (url: string, init?: RequestInit) => {
    calls.push({
      url,
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    const next = responses[i++] ?? { status: 200, body: {} };
    return new Response(JSON.stringify(next.body ?? {}), { status: next.status ?? 200 });
  };
  return { calls, fetchImpl };
};

/** The query string of a QuickBooks/Xero read, decoded. */
const queryOf = (url: string, param: string): string =>
  new URL(url).searchParams.get(param) ?? "";

describe("quickbooks destination", () => {
  const push = (
    rows: Record<string, unknown>[],
    opts: {
      fetchImpl: any;
      settings?: Record<string, unknown>;
      columns?: Record<string, string>;
      syncKey?: string;
    },
  ) =>
    pushToDestination(
      "quickbooks",
      {
        config: { _oauthAccessToken: "tok", realmId: "9130" },
        settings: { entity: "Customer", environment: "production", ...(opts.settings ?? {}) },
        rows,
        columns: opts.columns ?? { id: "text", displayName: "text" },
        syncKey: opts.syncKey ?? "sync-a",
      },
      opts.fetchImpl,
    );

  const invoicePush = (
    rows: Record<string, unknown>[],
    opts: { fetchImpl: any; settings?: Record<string, unknown>; syncKey?: string },
  ) =>
    push(rows, {
      ...opts,
      settings: { entity: "Invoice", ...(opts.settings ?? {}) },
      columns: { id: "text", customerName: "text", amount: "number" },
    });

  /** Answers the batch lookup with nothing, so every row is a create. */
  const NONE = { body: { QueryResponse: {} } };
  const CREATED = { body: { Customer: { Id: "7", SyncToken: "0" } } };

  test("declares its columns per record type, and a batch small enough to write row by row", () => {
    const all = DESTINATION_COLUMNS.quickbooks?.map((c) => c.value) ?? [];
    expect(all).toContain("displayName");
    expect(all).toContain("dueDate");
    // The narrowed sets are what a form should offer: `dueDate` on a customer
    // is a column the provider would drop while the run reported success.
    const customer = destinationColumnsFor("quickbooks", { entity: "Customer" })?.map((c) => c.value);
    expect(customer).toEqual(["displayName", "companyName", "email", "phone", "notes"]);
    expect(destinationColumnsFor("quickbooks", { entity: "Invoice" })?.map((c) => c.value)).toContain(
      "dueDate",
    );
    // One query for the batch plus a write per row, and the engine multiplies
    // it by a 20-page budget.
    expect(DESTINATION_BATCH_SIZE.quickbooks).toBeLessThanOrEqual(20);
  });

  test("Intuit's one accounting scope is read AND write, so nothing is required", () => {
    // Stated as a test because the Xero twin DOES require scopes, and a reader
    // meeting only that one would take the absence here for an oversight.
    expect(PROVIDERS.quickbooks.destination?.requiredScope).toBeUndefined();
  });

  describe("customers", () => {
    test("looks the whole batch up in one query, then writes each row", async () => {
      const { calls, fetchImpl } = recorder([NONE, CREATED, CREATED]);
      await push(
        [
          { id: "c1", displayName: "Ada Lovelace" },
          { id: "c2", displayName: "Grace Hopper" },
        ],
        { fetchImpl },
      );
      expect(calls).toHaveLength(3);
      expect(queryOf(calls[0]!.url, "query")).toBe(
        "select * from Customer where DisplayName in ('Ada Lovelace', 'Grace Hopper')",
      );
      expect(calls[1]!.url).toContain("/customer?");
      expect(calls[1]!.body.DisplayName).toBe("Ada Lovelace");
    });

    test("a create carries no id, and does not claim to be an update", async () => {
      const { calls, fetchImpl } = recorder([NONE, CREATED]);
      await push([{ id: "c1", displayName: "Ada Lovelace" }], { fetchImpl });
      expect(calls[1]!.url).not.toContain("operation=update");
      expect(calls[1]!.body.Id).toBeUndefined();
    });

    test("an existing customer is updated SPARSELY, not replaced", async () => {
      const { calls, fetchImpl } = recorder([
        { body: { QueryResponse: { Customer: [{ Id: "42", SyncToken: "3", DisplayName: "Ada" }] } } },
        { body: { Customer: { Id: "42", SyncToken: "4" } } },
      ]);
      await push([{ id: "c1", displayName: "Ada", email: "ada@example.com" }], {
        fetchImpl,
        columns: { id: "text", displayName: "text", email: "text" },
      });
      expect(calls[1]!.url).toContain("operation=update");
      expect(calls[1]!.body.Id).toBe("42");
      // Without the token Intuit refuses the write; without `sparse` it wipes
      // every field this sync does not know about — terms, tax codes, notes an
      // accountant typed.
      expect(calls[1]!.body.SyncToken).toBe("3");
      expect(calls[1]!.body.sparse).toBe(true);
    });

    test("an apostrophe in a name is escaped, not concatenated", async () => {
      const { calls, fetchImpl } = recorder([NONE, CREATED]);
      await push([{ id: "c1", displayName: "O'Brien & Co" }], { fetchImpl });
      // `O'Brien` is a customer, not an attack, and it is exactly the input
      // that ends a naive query early.
      expect(queryOf(calls[0]!.url, "query")).toBe(
        "select * from Customer where DisplayName in ('O\\'Brien & Co')",
      );
    });

    test("a row with no name is skipped, not failed", async () => {
      const { calls, fetchImpl } = recorder([NONE, CREATED]);
      await push([{ id: "c1", displayName: "" }, { id: "c2", displayName: "Ada" }], { fetchImpl });
      expect(calls).toHaveLength(2);
      expect(calls[1]!.body.DisplayName).toBe("Ada");
    });

    test("a batch of nothing usable makes no call at all", async () => {
      const { calls, fetchImpl } = recorder();
      await push([{ id: "c1", displayName: null }], { fetchImpl });
      expect(calls).toHaveLength(0);
    });
  });

  describe("invoices", () => {
    const CUSTOMER_FOUND = {
      body: { QueryResponse: { Customer: [{ Id: "42", SyncToken: "0", DisplayName: "Ada" }] } },
    };
    const NO_INVOICE = { body: { QueryResponse: {} } };
    const SAVED = { body: { Invoice: { Id: "5", SyncToken: "0" } } };
    const ROW = { id: "inv_1", customerName: "Ada", amount: 250.5 };

    test("mints a document number and always addresses the same invoice with it", async () => {
      const first = recorder([CUSTOMER_FOUND, NO_INVOICE, SAVED]);
      await invoicePush([ROW], { fetchImpl: first.fetchImpl });
      const second = recorder([CUSTOMER_FOUND, NO_INVOICE, SAVED]);
      await invoicePush([{ ...ROW, amount: 300 }], { fetchImpl: second.fetchImpl });
      const doc = first.calls[2]!.body.DocNumber;
      expect(doc).toMatch(/^BX-[0-9A-F]{12}$/);
      // The whole idempotency story: a re-sent batch updates rather than
      // invoicing the customer a second time.
      expect(second.calls[2]!.body.DocNumber).toBe(doc);
    });

    test("two syncs into one company never collide", async () => {
      const a = recorder([CUSTOMER_FOUND, NO_INVOICE, SAVED]);
      await invoicePush([ROW], { fetchImpl: a.fetchImpl, syncKey: "sync-a" });
      const b = recorder([CUSTOMER_FOUND, NO_INVOICE, SAVED]);
      await invoicePush([ROW], { fetchImpl: b.fetchImpl, syncKey: "sync-b" });
      // Two collections can hold the same primary key.
      expect(b.calls[2]!.body.DocNumber).not.toBe(a.calls[2]!.body.DocNumber);
    });

    test("a mapped invoice number wins over the minted one", async () => {
      const { calls, fetchImpl } = recorder([CUSTOMER_FOUND, NO_INVOICE, SAVED]);
      await invoicePush([{ ...ROW, docNumber: "INV-2026-001" }], { fetchImpl });
      expect(calls[2]!.body.DocNumber).toBe("INV-2026-001");
    });

    test("an unknown customer is created, because an invoice cannot exist without one", async () => {
      const { calls, fetchImpl } = recorder([
        { body: { QueryResponse: {} } },
        NO_INVOICE,
        { body: { Customer: { Id: "99", SyncToken: "0" } } },
        SAVED,
      ]);
      await invoicePush([ROW], { fetchImpl });
      expect(calls[2]!.url).toContain("/customer?");
      expect(calls[2]!.body.DisplayName).toBe("Ada");
      expect(calls[3]!.body.CustomerRef).toEqual({ value: "99" });
    });

    test("…unless the sync was told to skip those rows instead", async () => {
      const { calls, fetchImpl } = recorder([{ body: { QueryResponse: {} } }, NO_INVOICE]);
      await invoicePush([ROW], { fetchImpl, settings: { missingCustomer: "skip" } });
      // Two lookups and nothing written: creating a customer is a change to
      // someone's ledger, and an operator may want it to stay theirs.
      expect(calls).toHaveLength(2);
    });

    test("a row with no amount is skipped rather than posted as zero", async () => {
      const { calls, fetchImpl } = recorder();
      await invoicePush([{ id: "inv_1", customerName: "Ada", amount: null }], { fetchImpl });
      expect(calls).toHaveLength(0);
    });

    test("an amount written the way a currency column holds it still parses", async () => {
      const { calls, fetchImpl } = recorder([CUSTOMER_FOUND, NO_INVOICE, SAVED]);
      await invoicePush([{ ...ROW, amount: "1.234,56" }], { fetchImpl });
      expect(calls[2]!.body.Line[0].Amount).toBe(1234.56);
    });

    test("dates travel as calendar days, whichever way the dialect stored them", async () => {
      const { calls, fetchImpl } = recorder([CUSTOMER_FOUND, NO_INVOICE, SAVED]);
      await invoicePush([{ ...ROW, dueDate: Date.parse("2026-09-01T10:00:00Z") }], { fetchImpl });
      expect(calls[2]!.body.DueDate).toBe("2026-09-01");
    });

    test("a named product resolves to a line item reference", async () => {
      const { calls, fetchImpl } = recorder([
        CUSTOMER_FOUND,
        NO_INVOICE,
        { body: { QueryResponse: { Item: [{ Id: "12" }] } } },
        SAVED,
      ]);
      await invoicePush([ROW], { fetchImpl, settings: { item: "Consulting" } });
      expect(calls[3]!.body.Line[0].SalesItemLineDetail).toEqual({ ItemRef: { value: "12" } });
    });

    test("a product name that matches nothing stops the batch", async () => {
      const { fetchImpl } = recorder([CUSTOMER_FOUND, NO_INVOICE, { body: { QueryResponse: {} } }]);
      // A configuration mistake, not a data one: posting these without the line
      // item would file every invoice against the wrong account.
      await expect(invoicePush([ROW], { fetchImpl, settings: { item: "Nope" } })).rejects.toThrow(
        /no product\/service named/i,
      );
    });
  });

  describe("failures an operator has to tell apart", () => {
    test("a 401 says to reconnect", async () => {
      const { fetchImpl } = recorder([{ status: 401 }]);
      await expect(push([{ id: "c1", displayName: "Ada" }], { fetchImpl })).rejects.toThrow(
        /reauthorize/i,
      );
    });

    test("a 429 does NOT — it is a wait, not a broken connection", async () => {
      const { fetchImpl } = recorder([{ status: 429 }]);
      await expect(push([{ id: "c1", displayName: "Ada" }], { fetchImpl })).rejects.toThrow(
        /rate-limited/i,
      );
    });

    test("a validation failure carries Intuit's own words", async () => {
      const { fetchImpl } = recorder([
        NONE,
        { status: 400, body: { Fault: { Error: [{ Detail: "Duplicate Name Exists Error" }] } } },
      ]);
      await expect(push([{ id: "c1", displayName: "Ada" }], { fetchImpl })).rejects.toThrow(
        /Duplicate Name Exists/,
      );
    });

    test("a missing company id fails before any call is made", async () => {
      const { calls, fetchImpl } = recorder();
      await expect(
        pushToDestination(
          "quickbooks",
          {
            config: { _oauthAccessToken: "tok" },
            settings: { entity: "Customer" },
            rows: [{ id: "c1", displayName: "Ada" }],
            columns: { id: "text", displayName: "text" },
            syncKey: "s",
          },
          fetchImpl,
        ),
      ).rejects.toThrow(/company id/);
      expect(calls).toHaveLength(0);
    });

    test("a mapping belonging to the other record type is refused, not ignored", async () => {
      const { calls, fetchImpl } = recorder();
      await expect(
        push([{ id: "c1", displayName: "Ada" }], {
          fetchImpl,
          columns: { id: "text", displayName: "text", dueDate: "timestamp" },
        }),
      ).rejects.toThrow(/no column "dueDate"/);
      expect(calls).toHaveLength(0);
    });
  });
});

describe("xero destination", () => {
  const CONNECTIONS = { body: [{ tenantId: "org-1", tenantName: "Acme Ltd" }] };

  const push = (
    rows: Record<string, unknown>[],
    opts: {
      fetchImpl: any;
      settings?: Record<string, unknown>;
      columns?: Record<string, string>;
      syncKey?: string;
    },
  ) =>
    pushToDestination(
      "xero",
      {
        config: { _oauthAccessToken: "tok" },
        settings: { endpoint: "Contacts", ...(opts.settings ?? {}) },
        rows,
        columns: opts.columns ?? { id: "text", name: "text" },
        syncKey: opts.syncKey ?? "sync-a",
      },
      opts.fetchImpl,
    );

  const invoicePush = (
    rows: Record<string, unknown>[],
    opts: { fetchImpl: any; settings?: Record<string, unknown>; syncKey?: string },
  ) =>
    push(rows, {
      ...opts,
      settings: { endpoint: "Invoices", ...(opts.settings ?? {}) },
      columns: { id: "text", contactName: "text", amount: "number" },
    });

  test("requires BOTH write grants, because Xero splits them per record type", () => {
    expect(PROVIDERS.xero.destination?.requiredScope).toEqual([
      "accounting.contacts",
      "accounting.transactions",
    ]);
  });

  test("narrows its columns by record type like the QuickBooks twin", () => {
    expect(destinationColumnsFor("xero", { endpoint: "Contacts" })?.map((c) => c.value)).toContain(
      "taxNumber",
    );
    expect(destinationColumnsFor("xero", { endpoint: "Contacts" })?.map((c) => c.value)).not.toContain(
      "dueDate",
    );
  });

  test("resolves which organisation it is writing to, and says so on every call", async () => {
    const { calls, fetchImpl } = recorder([CONNECTIONS, { body: { Contacts: [] } }, { body: {} }]);
    await push([{ id: "c1", name: "Ada" }], { fetchImpl });
    expect(calls[0]!.url).toBe("https://api.xero.com/connections");
    // The token alone does not say which set of books this is.
    expect(calls).toHaveLength(3);
  });

  test("an unknown organisation name fails with the name in the message", async () => {
    const { fetchImpl } = recorder([CONNECTIONS]);
    await expect(
      push([{ id: "c1", name: "Ada" }], { fetchImpl, settings: { organisation: "Other Ltd" } }),
    ).rejects.toThrow(/Other Ltd/);
  });

  describe("contacts", () => {
    test("finds the batch in one call and writes it in one more", async () => {
      const { calls, fetchImpl } = recorder([CONNECTIONS, { body: { Contacts: [] } }, { body: {} }]);
      await push(
        [
          { id: "c1", name: "Ada" },
          { id: "c2", name: "Grace" },
        ],
        { fetchImpl },
      );
      expect(calls).toHaveLength(3);
      expect(queryOf(calls[1]!.url, "where")).toMatch(
        /^ContactNumber=="BX-[0-9A-F]{12}" OR ContactNumber=="BX-[0-9A-F]{12}"$/,
      );
      expect(calls[2]!.method).toBe("POST");
      expect(calls[2]!.body.Contacts).toHaveLength(2);
    });

    test("an existing contact is updated by its id, not created again", async () => {
      const probe = recorder([CONNECTIONS, { body: { Contacts: [] } }, { body: {} }]);
      await push([{ id: "c1", name: "Ada" }], { fetchImpl: probe.fetchImpl });
      const number = probe.calls[2]!.body.Contacts[0].ContactNumber;

      const { calls, fetchImpl } = recorder([
        CONNECTIONS,
        { body: { Contacts: [{ ContactID: "xero-9", ContactNumber: number }] } },
        { body: {} },
      ]);
      await push([{ id: "c1", name: "Ada Lovelace" }], { fetchImpl });
      expect(calls[2]!.body.Contacts[0].ContactID).toBe("xero-9");
      expect(calls[2]!.body.Contacts[0].Name).toBe("Ada Lovelace");
    });

    test("a mapped contact code wins over the minted one", async () => {
      const { calls, fetchImpl } = recorder([CONNECTIONS, { body: { Contacts: [] } }, { body: {} }]);
      await push([{ id: "c1", name: "Ada", contactNumber: "CUST-001" }], {
        fetchImpl,
        columns: { id: "text", name: "text", contactNumber: "text" },
      });
      expect(calls[2]!.body.Contacts[0].ContactNumber).toBe("CUST-001");
      expect(queryOf(calls[1]!.url, "where")).toBe('ContactNumber=="CUST-001"');
    });

    test("a phone becomes the typed entry Xero actually stores", async () => {
      const { calls, fetchImpl } = recorder([CONNECTIONS, { body: { Contacts: [] } }, { body: {} }]);
      await push([{ id: "c1", name: "Ada", phone: "+90 555 000 0000" }], {
        fetchImpl,
        columns: { id: "text", name: "text", phone: "text" },
      });
      expect(calls[2]!.body.Contacts[0].Phones).toEqual([
        { PhoneType: "DEFAULT", PhoneNumber: "+90 555 000 0000" },
      ]);
    });

    test("a double quote in a code cannot end the filter expression", async () => {
      const { calls, fetchImpl } = recorder([CONNECTIONS, { body: { Contacts: [] } }, { body: {} }]);
      await push([{ id: "c1", name: "Ada", contactNumber: 'A"B' }], {
        fetchImpl,
        columns: { id: "text", name: "text", contactNumber: "text" },
      });
      expect(queryOf(calls[1]!.url, "where")).toBe('ContactNumber=="A\\"B"');
    });
  });

  describe("invoices", () => {
    const ROW = { id: "inv_1", contactName: "Ada", amount: 250.5 };
    const NO_INVOICE = { body: { Invoices: [] } };

    test("names the contact rather than referencing one, because Xero will create it", async () => {
      const { calls, fetchImpl } = recorder([CONNECTIONS, NO_INVOICE, { body: {} }]);
      await invoicePush([ROW], { fetchImpl });
      const invoice = calls[2]!.body.Invoices[0];
      expect(invoice.Contact).toEqual({ Name: "Ada" });
      expect(invoice.LineItems[0].UnitAmount).toBe(250.5);
    });

    test("is a DRAFT unless someone chose otherwise", async () => {
      const draft = recorder([CONNECTIONS, NO_INVOICE, { body: {} }]);
      await invoicePush([ROW], { fetchImpl: draft.fetchImpl });
      // An automation that posts to the ledger on its first run is not
      // something an operator should have to opt out of.
      expect(draft.calls[2]!.body.Invoices[0].Status).toBe("DRAFT");

      const live = recorder([CONNECTIONS, NO_INVOICE, { body: {} }]);
      await invoicePush([ROW], { fetchImpl: live.fetchImpl, settings: { invoiceStatus: "AUTHORISED" } });
      expect(live.calls[2]!.body.Invoices[0].Status).toBe("AUTHORISED");
    });

    test("a paid invoice is left alone, not retried until the sync pauses", async () => {
      const probe = recorder([CONNECTIONS, NO_INVOICE, { body: {} }]);
      await invoicePush([ROW], { fetchImpl: probe.fetchImpl });
      const number = probe.calls[2]!.body.Invoices[0].InvoiceNumber;

      const { calls, fetchImpl } = recorder([
        CONNECTIONS,
        { body: { Invoices: [{ InvoiceID: "x1", InvoiceNumber: number, Status: "PAID" }] } },
        { body: {} },
      ]);
      await invoicePush([{ ...ROW, amount: 999 }], { fetchImpl });
      // Xero refuses to modify it — permanently. Sending it anyway is a 400 the
      // engine would retry until the breaker paused a sync over a finished row.
      // Nothing survives the batch, so there is no write call at all.
      expect(calls.map((c) => c.method)).toEqual(["GET", "GET"]);
    });

    test("an account code reaches the line, where the revenue posts", async () => {
      const { calls, fetchImpl } = recorder([CONNECTIONS, NO_INVOICE, { body: {} }]);
      await invoicePush([ROW], { fetchImpl, settings: { accountCode: "200" } });
      expect(calls[2]!.body.Invoices[0].LineItems[0].AccountCode).toBe("200");
    });

    test("a line always has a description, because Xero requires one", async () => {
      const { calls, fetchImpl } = recorder([CONNECTIONS, NO_INVOICE, { body: {} }]);
      await invoicePush([ROW], { fetchImpl });
      expect(calls[2]!.body.Invoices[0].LineItems[0].Description).toContain("BX-");
    });
  });

  test("a validation failure carries Xero's own words", async () => {
    const { fetchImpl } = recorder([
      CONNECTIONS,
      { body: { Contacts: [] } },
      {
        status: 400,
        body: {
          Elements: [{ ValidationErrors: [{ Message: "Contact Name must be unique" }] }],
        },
      },
    ]);
    await expect(push([{ id: "c1", name: "Ada" }], { fetchImpl })).rejects.toThrow(
      /Contact Name must be unique/,
    );
  });

  test("a 403 says to reconnect — the grant, not the data, is what is wrong", async () => {
    const { fetchImpl } = recorder([CONNECTIONS, { status: 403 }]);
    await expect(push([{ id: "c1", name: "Ada" }], { fetchImpl })).rejects.toThrow(/reconnect/i);
  });
});
