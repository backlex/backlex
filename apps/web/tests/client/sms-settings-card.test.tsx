/**
 * Render coverage for the SMS provider picker in Settings → Messaging.
 *
 * The card is table-driven: `SMS_PROVIDER_OPTIONS` fills the dropdown and
 * `SMS_PROVIDER_FIELDS` decides which credential inputs appear. Neither table is
 * type-linked to the server registry, so a provider added in `sms-select.ts` and
 * forgotten here is silently unconfigurable, and a secret field whose key isn't
 * in `SMS_SECRET_KEYS` is silently dropped by the PUT route — the admin types a
 * password, sees "saved", and the send keeps using the old transport. These
 * tests pin both seams plus the per-provider field swap.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, screen, waitFor } from "@testing-library/react";
import {
  SMS_PROVIDER_FIELDS,
  SMS_PROVIDER_OPTIONS,
  SmsSettingsCard,
} from "../../src/client/admin/pages/settings/messaging-cards";
import { SMS_PROVIDER_IDS } from "../../src/server/lib/sms-select";
import { SMS_SECRET_KEYS } from "../../src/server/services/sms-config";
import { renderWithProviders } from "./render";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const mockSmsConfig = (row: Record<string, unknown>) => {
  global.fetch = mock(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("/api/admin/sms-config")) return json({ data: row });
    return json({ error: { code: "NOT_FOUND", message: `unmocked ${url}` } }, 404);
  }) as unknown as typeof fetch;
};

/** Field labels only — the provider hint paragraph repeats several of these
 *  words, so match on `<label>` elements instead of any text node. */
const labels = (): string[] =>
  [...document.querySelectorAll("label")].map((l) => l.textContent ?? "");
const hasLabel = (re: RegExp): boolean => labels().some((l) => re.test(l));

const row = (over: Record<string, unknown> = {}) => ({
  tenantId: "t1",
  provider: "inherit",
  config: {},
  secretsSet: {},
  updatedAt: null,
  env: { provider: null },
  ...over,
});

describe("SMS provider tables", () => {
  test("the dropdown offers exactly the providers the server accepts", () => {
    expect(SMS_PROVIDER_OPTIONS.map((o) => o.value)).toEqual([...SMS_PROVIDER_IDS]);
  });

  test("every provider id has a field definition", () => {
    for (const id of SMS_PROVIDER_IDS) expect(SMS_PROVIDER_FIELDS[id]).toBeTruthy();
  });

  test("every secret input maps to a key the PUT route actually encrypts", () => {
    for (const [id, def] of Object.entries(SMS_PROVIDER_FIELDS)) {
      for (const [key] of def.secrets) {
        // A key outside SMS_SECRET_KEYS is dropped server-side without error.
        expect({ id, key }).toEqual({ id, key: SMS_SECRET_KEYS.find((k) => k === key) ?? key });
        expect(SMS_SECRET_KEYS).toContain(key as (typeof SMS_SECRET_KEYS)[number]);
      }
    }
  });

  test("no credential is offered as a plain config field", () => {
    // Config values come back in the GET response; secrets never do. A slip here
    // would publish the credential to every workspace admin in plaintext.
    for (const def of Object.values(SMS_PROVIDER_FIELDS)) {
      for (const [key] of def.config) {
        expect(SMS_SECRET_KEYS).not.toContain(key as (typeof SMS_SECRET_KEYS)[number]);
      }
    }
  });

  test("the TR providers declare their documented credential shape", () => {
    expect(SMS_PROVIDER_FIELDS.netgsm!.config.map(([k]) => k)).toEqual(["usercode", "msgheader"]);
    expect(SMS_PROVIDER_FIELDS.netgsm!.secrets.map(([k]) => k)).toEqual(["password"]);
    expect(SMS_PROVIDER_FIELDS.iletimerkezi!.config.map(([k]) => k)).toEqual(["key", "sender"]);
    expect(SMS_PROVIDER_FIELDS.iletimerkezi!.secrets.map(([k]) => k)).toEqual(["hash"]);
  });
});

describe("<SmsSettingsCard>", () => {
  const realFetch = global.fetch;
  afterEach(() => {
    cleanup();
    global.fetch = realFetch;
  });

  test("the provider field is a listbox trigger, not a free-text input", async () => {
    mockSmsConfig(row());
    renderWithProviders(<SmsSettingsCard pushToast={() => {}} />);
    await waitFor(() => expect(document.querySelector("[role=combobox]")).toBeTruthy());
    const trigger = document.querySelector("[role=combobox]") as HTMLElement;
    expect(trigger.tagName).not.toBe("INPUT");
  });

  test("a netgsm row renders NetGSM's fields and none of Twilio's", async () => {
    mockSmsConfig(
      row({ provider: "netgsm", config: { usercode: "8501234567", msgheader: "MYCOMPANY" } }),
    );
    renderWithProviders(<SmsSettingsCard pushToast={() => {}} />);

    await waitFor(() => expect(hasLabel(/User code/i)).toBe(true));
    expect(hasLabel(/Message header/i)).toBe(true);
    expect(hasLabel(/Panel password/i)).toBe(true);
    // Leaking Twilio's inputs here would PUT a NetGSM password as `authToken`.
    expect(hasLabel(/Account SID/i)).toBe(false);
    expect(hasLabel(/Auth Token/i)).toBe(false);
  });

  test("an iletimerkezi row renders key / sender / hash", async () => {
    mockSmsConfig(row({ provider: "iletimerkezi", config: { key: "k", sender: "MYCOMPANY" } }));
    renderWithProviders(<SmsSettingsCard pushToast={() => {}} />);

    await waitFor(() => expect(hasLabel(/API key/i)).toBe(true));
    expect(hasLabel(/Sender title/i)).toBe(true);
    expect(hasLabel(/API hash/i)).toBe(true);
    expect(hasLabel(/User code/i)).toBe(false);
  });

  test("a stored secret renders masked — never the value", async () => {
    mockSmsConfig(
      row({
        provider: "netgsm",
        config: { usercode: "8501234567", msgheader: "MYCOMPANY" },
        secretsSet: { password: true },
      }),
    );
    renderWithProviders(<SmsSettingsCard pushToast={() => {}} />);

    await waitFor(() => expect(document.querySelector("textarea")).toBeTruthy());
    const box = document.querySelector("textarea") as HTMLTextAreaElement;
    // The API never returns the secret, so the box starts empty with only a
    // "stored" affordance.
    expect(box.value).toBe("");
    expect(box.placeholder).toContain("•");
    expect(screen.queryByText(/A value is stored/i)).toBeTruthy();
  });
});
