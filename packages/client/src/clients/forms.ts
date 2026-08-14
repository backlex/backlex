import { BacklexError } from "../types";
import type { ClientCore } from "../core";

/** One block on a public form (order = render order). `kind: "field"` exposes
 *  a collection field; `kind: "step"` is a presentation-only page break;
 *  `kind: "matrix"` asks several fields on one shared set of columns. */
export interface PublicFormBlockConfig {
  /** Stable client id for builder selection/reorder. Optional; preserved. */
  id?: string;
  /** Defaults to "field" when omitted (legacy configs). */
  kind?: "field" | "step" | "matrix";
  /** Collection field name — required for field blocks. */
  name?: string;
  /** Display label override; step blocks use it as the step title. */
  label?: string;
  placeholder?: string;
  /** Help text override shown beneath the input. */
  help?: string;
  /** @deprecated Integer fields only: 1–5 star rating. Superseded by
   *  {@link PublicFormBlockConfig.scale}; still read, so existing forms keep
   *  rendering unchanged. */
  rating?: boolean;
  /** Integer fields only: answer by picking a point on a row — a star rating,
   *  a numbered row, or the 0–10 NPS row (which the results panel scores as
   *  promoters − detractors). At most 11 points wide; the bound is enforced on
   *  submit, so an answer off the row is refused rather than stored. */
  scale?: {
    min: number;
    max: number;
    style: "stars" | "number" | "nps";
    /** Anchor captions under the two ends ("Not at all" … "Extremely"). */
    minLabel?: string;
    maxLabel?: string;
  };
  /**
   * Matrix blocks only: the statements the grid asks, top to bottom.
   *
   * Each row names an ordinary collection field and its answer lands in that
   * field's own column — the grid is how the question is drawn, not where it
   * goes, so the results panel, dashboards and exports read the rows as the
   * questions they are. The rows must agree on their columns: either every row
   * is an `integer` field answered on the block's shared {@link scale}, or
   * every row offers the same choices in the same order (the likert grid).
   */
  rows?: Array<{
    /** Collection field this row's answer is written into. */
    name: string;
    /** Row caption; falls back to the field's own label. */
    label?: string;
    i18n?: Record<string, { label?: string; placeholder?: string; help?: string }>;
  }>;
  /** Boolean fields only: consent checkbox — submits must carry `true`. */
  consent?: boolean;
  /** Optional "read the full text" URL shown next to a consent block. */
  policyUrl?: string;
  /** Show-condition: render only when another field's answer matches. */
  cond?: { field: string; op: "is" | "is_not"; value: string };
  /** Per-locale string overrides; missing strings fall back to the base. */
  i18n?: Record<string, { label?: string; placeholder?: string; help?: string }>;
}

/** @deprecated Renamed to {@link PublicFormBlockConfig}. */
export type PublicFormFieldConfig = PublicFormBlockConfig;

/** Behaviour + appearance knobs for a public form. */
export interface PublicFormSettings {
  /** Sub-heading under the form title on the public page. */
  description?: string;
  submitLabel?: string;
  successMessage?: string;
  redirectUrl?: string;
  /** Require a Cloudflare Turnstile pass on submit (server needs the secret). */
  turnstile?: boolean;
  theme?: "dark" | "light";
  accent?: string;
  font?: "sans" | "lexend" | "mono" | "system";
  /** Offered locales, base language first. `?lang=xx` forces one publicly. */
  languages?: string[];
  i18n?: Record<
    string,
    { title?: string; description?: string; submitLabel?: string; successMessage?: string }
  >;
  /** Epoch ms before which the form does not take answers yet. */
  opensAt?: number;
  /** Epoch ms from which it stops taking them. */
  closesAt?: number;
  /** Stop accepting once this many submissions have been accepted. Checked
   *  before the row is written, so a simultaneous burst can land a couple
   *  over it. */
  maxResponses?: number;
  /** One answer per browser — a cookie, not an identity: another browser or a
   *  cleared one answers again. Use invite links when it must be one person. */
  onePerBrowser?: boolean;
  /** Only a visitor holding an unspent invite may answer (`/f/<token>?i=…`).
   *  Mint them with `forms.invite()`. */
  inviteOnly?: boolean;
  /** Keep what someone has filled in so far, so they can come back to it. An
   *  invited person resumes through their own link on any device; everyone else
   *  through an opaque cookie, so another browser starts fresh. */
  saveProgress?: boolean;
  /** What the public page says once the form is closed. */
  closedMessage?: string;
}

/** A public form definition. Mirrors `/api/admin/forms`. The public token is
 *  never present — it is returned once by `create` / `rotateToken`. */
export interface PublicForm {
  id: string;
  tenantId?: string | null;
  name: string;
  collection: string;
  fields: PublicFormBlockConfig[];
  settings: PublicFormSettings | null;
  active: boolean;
  /** All-time accepted submissions. */
  submissionCount: number;
  /** Submissions rejected by honeypot / Turnstile / rate limit. */
  blockedCount: number;
  lastSubmissionAt: unknown;
}

/** Create/update payload for a public form. */
export interface PublicFormInput {
  name: string;
  collection: string;
  fields: PublicFormBlockConfig[];
  settings?: PublicFormSettings | null;
  active?: boolean;
}

/** Outcome of minting/rotating a form token. `token` is shown exactly once;
 *  `url`/`embedUrl` are the relative public page paths. */
export interface PublicFormToken {
  token: string;
  url: string;
  embedUrl: string;
}

/** A collection field that may be exposed on a public form. */
export interface PublicFormEligibleField {
  name: string;
  type: string;
  label: string | null;
  required: boolean;
  /** Dropdown choice values, when the field defines them. */
  choices: string[] | null;
  /** email/url format hint from the field's validation rules. */
  format: string | null;
}

export interface FormsClient {
  /** List every public form in the active workspace. */
  list(): Promise<{ data: PublicForm[] }>;
  /** Fetch a single form by id. */
  get(id: string): Promise<{ data: PublicForm }>;
  /** A collection's form-eligible fields (scalar, non-private, non-computed). */
  eligibleFields(collection: string): Promise<{ data: PublicFormEligibleField[] }>;
  /** Create a form; returns the one-time plaintext token + public URLs. */
  create(input: PublicFormInput): Promise<{ data: { form: PublicForm } & PublicFormToken }>;
  /** Partial update of a form by id. */
  update(id: string, patch: Partial<PublicFormInput>): Promise<{ data: PublicForm }>;
  /** Replace the public token — the old link dies immediately. */
  rotateToken(id: string): Promise<{ data: PublicFormToken }>;
  /** One distribution per exposed question. Counts only — free-text answers
   *  are never quoted here; read those through `items.list()`. */
  results(id: string): Promise<{ data: PublicFormResults }>;
  /** Who was invited, whether their mail went out, whether they answered.
   *  Tokens are never listed — a lost link is re-minted, not recovered. */
  invites(id: string): Promise<{ data: PublicFormInvite[] }>;
  /** Mint one single-use link per recipient. The plaintext tokens are in THIS
   *  response and nowhere else. */
  invite(
    id: string,
    input: PublicFormInviteInput,
  ): Promise<{ data: { invites: MintedPublicFormInvite[]; sent: number } }>;
  /**
   * Mint a fresh link for everyone who hasn't answered, and optionally mail it.
   *
   * Earlier links keep working: every link an invite has ever had opens the
   * same turn, and spending any one spends it — the person being reminded is
   * precisely the person whose first link must not break. Answered invites are
   * never reminded, and nobody is reminded twice inside `minIntervalHours`
   * (default 24) unless `force`.
   */
  remindInvites(
    id: string,
    input?: PublicFormRemindInput,
  ): Promise<{
    data: { invites: MintedPublicFormInvite[]; sent: number; skipped: number };
  }>;
  /** Revoke an invite; every link that opened it stops working immediately. */
  revokeInvite(id: string, inviteId: string): Promise<{ ok: boolean }>;
  /** Delete a form; its link stops working immediately. */
  delete(id: string): Promise<{ ok: boolean }>;
  /**
   * The VISITOR's side of a form: render it, fill it, send it.
   *
   * Everything above authors forms; this is the half that uses one, and it is
   * what a public form is for. Every call here is **unauthenticated** and
   * addressed by the form's public token, so it works on a client built with
   * no session at all — which is exactly how an application embedding its own
   * form should build one.
   */
  public: PublicFormFillClient;
}

/** One rendered block of a form, as the visitor's page draws it. */
export interface PublicFormRenderedBlock {
  kind?: "field" | "step" | "matrix";
  field?: string;
  label?: string;
  type?: string;
  required?: boolean;
  choices?: unknown;
  [key: string]: unknown;
}

/** A form resolved for rendering, plus whatever this visitor left behind. */
export interface PublicFormRendered {
  id: string;
  title: string | null;
  blocks: PublicFormRenderedBlock[];
  submitLabel: string | null;
  successMessage: string | null;
  redirectUrl: string | null;
  theme: "dark" | "light";
  accent: string | null;
  languages: string[];
  locale: string;
  turnstileSiteKey: string | null;
  /** True ⇒ the form is meant to save progress as it is filled in. */
  saveProgress: boolean;
  /**
   * What this visitor left behind last time, or `null` for a fresh start.
   *
   * There is no separate "resume" call: resuming IS rendering. The draft is
   * filed under a cookie the server set, or — on an invite-only form — under
   * the invite token, so the same request that fetches the questions brings
   * back the answers already given.
   */
  draft: { data: Record<string, unknown>; step: number; savedAt: number } | null;
  [key: string]: unknown;
}

/** What a submission returns: the row id, and where to send the visitor. */
export interface PublicFormSubmitResult {
  id: string | null;
  successMessage: string | null;
  redirectUrl: string | null;
}

/** The visitor-facing half of a public form (`/api/public/forms/:token`). */
export interface PublicFormFillClient {
  /**
   * Resolve a public token to the form to draw — and to the draft to resume.
   *
   * Never exposes a field the form does not list. A paused form answers 410
   * rather than rendering, so a link that is over says so.
   */
  render(token: string, opts?: { lang?: string }): Promise<{ data: PublicFormRendered }>;
  /** Upload a file for one of the form's file blocks. */
  upload(
    token: string,
    file: Blob | File,
    opts?: { field?: string; invite?: string },
  ): Promise<unknown>;
  /** Save a half-filled form so the visitor can come back to it. */
  saveDraft(
    token: string,
    input: { data: Record<string, unknown>; step?: number; invite?: string },
  ): Promise<unknown>;
  /** Throw the saved draft away. */
  discardDraft(token: string, opts?: { invite?: string }): Promise<unknown>;
  /** Send it. */
  submit(
    token: string,
    input: {
      data: Record<string, unknown>;
      /** Captcha response, when the form asks for one. */
      captchaToken?: string;
      turnstileToken?: string;
      /** Single-use invite token, required by invite-only forms. */
      invite?: string;
    },
    opts?: { lang?: string },
  ): Promise<{ data: PublicFormSubmitResult }>;
}

/** One invitation to answer a form. The token is never in a read response. */
export interface PublicFormInvite {
  id: string;
  formId: string;
  /** Null for an unaddressed link the operator hands out themselves. */
  email: string | null;
  name: string | null;
  /** When the invite email went out, or null if it never did. */
  sentAt: unknown;
  /** When it was spent. Non-null ⇒ every link into it stops working. */
  usedAt: unknown;
  /** When a reminder last went out to this person, and how many have. */
  remindedAt: unknown;
  reminderCount: number;
  createdAt: unknown;
}

/** A freshly minted invite — `token` and `url` appear only here. */
export interface MintedPublicFormInvite extends PublicFormInvite {
  token: string;
  /** Relative link, or "" when no `formToken` was supplied to build it with. */
  url: string;
}

export interface PublicFormInviteInput {
  recipients: { email?: string; name?: string }[];
  /** The form's own plaintext token (held from create/rotate), so the response
   *  can carry ready-made links. Never stored. */
  formToken?: string;
  /** Email each recipient their link. Recipients with no address are minted
   *  and simply not mailed. */
  send?: boolean;
}

export interface PublicFormRemindInput {
  /** Narrow to specific invites. Absent ⇒ everyone still outstanding. */
  inviteIds?: string[];
  /** The form's own plaintext token, so the response carries ready-made links. */
  formToken?: string;
  /** Email the reminder. Without it the fresh links are only in the response. */
  send?: boolean;
  /** Hours to leave between two reminders to one person (default 24). */
  minIntervalHours?: number;
  /** Remind anyway, however recently the last one went out. */
  force?: boolean;
}

/** How a question's answers are summarised. */
export type PublicFormResultKind =
  | "choice"
  | "multi_choice"
  | "scale"
  | "boolean"
  | "number"
  | "text"
  | "timestamp"
  | "file";

/** One question's answers, summarised. */
export interface PublicFormResultBlock {
  name: string;
  label: string;
  /** Storage type of the underlying column. */
  type: string;
  kind: PublicFormResultKind;
  /** Rows whose answer is not null. For `multi_choice` that is people, while
   *  the bucket counts are choices — so the buckets can sum to more. */
  answered: number;
  /** Distribution in the schema's own choice order (a scale runs low to high),
   *  or null for the kinds that have none. */
  buckets: { value: string; label: string; count: number }[] | null;
  /** Mean answer for scale/number questions. */
  average: number | null;
  /** `style: "nps"` scales only: promoters (9–10) minus detractors (0–6). */
  nps: { promoters: number; passives: number; detractors: number; score: number } | null;
  /** Set when the question was asked as one row of a matrix — blocks sharing
   *  an `id` were asked under one heading. The summary itself is unchanged:
   *  a matrix row is the scale or choice question it always was. */
  matrix: { id: string; label: string } | null;
}

/** A form's answers, summarised. Mirrors `GET /api/admin/forms/:id/results`. */
export interface PublicFormResults {
  formId: string;
  collection: string;
  /** Rows in the target collection right now. Nothing stamps a row with the
   *  form that wrote it, so anything else writing to the collection counts. */
  rows: number;
  submissionCount: number;
  blockedCount: number;
  /** Half-filled forms saved but not yet submitted — above zero only on a form
   *  with `saveProgress`. The figure the collection cannot tell you: people who
   *  started and stopped. */
  inProgress: number;
  lastSubmissionAt: unknown;
  blocks: PublicFormResultBlock[];
  /** Questions past the summary cap that were not computed. */
  truncated: number;
}

export const makeForms = (core: ClientCore): FormsClient => {
  // Public form builder. Admin-scoped over `/api/admin/forms`; the plaintext
  // token only ever appears in `create` / `rotateToken` responses.
  const formPath = (id: string) => `/api/admin/forms/${encodeURIComponent(id)}`;
  /** The visitor-facing mount. Public — no session, addressed by the form's
   *  own token rather than by its id. */
  const publicPath = (token: string) => `/api/public/forms/${encodeURIComponent(token)}`;
  const forms: FormsClient = {
    list: () => core.request<{ data: PublicForm[] }>("GET", "/api/admin/forms"),
    get: (id: string) => core.request<{ data: PublicForm }>("GET", formPath(id)),
    eligibleFields: (collection: string) =>
      core.request<{ data: PublicFormEligibleField[] }>(
        "GET",
        `/api/admin/forms/eligible-fields/${encodeURIComponent(collection)}`,
      ),
    create: (input: PublicFormInput) =>
      core.request<{ data: { form: PublicForm } & PublicFormToken }>(
        "POST",
        "/api/admin/forms",
        input,
      ),
    update: (id: string, patch: Partial<PublicFormInput>) =>
      core.request<{ data: PublicForm }>("PATCH", formPath(id), patch),
    rotateToken: (id: string) =>
      core.request<{ data: PublicFormToken }>("POST", `${formPath(id)}/rotate-token`),
    results: (id: string) =>
      core.request<{ data: PublicFormResults }>("GET", `${formPath(id)}/results`),
    invites: (id: string) =>
      core.request<{ data: PublicFormInvite[] }>("GET", `${formPath(id)}/invites`),
    invite: (id: string, input: PublicFormInviteInput) =>
      core.request<{ data: { invites: MintedPublicFormInvite[]; sent: number } }>(
        "POST",
        `${formPath(id)}/invites`,
        input,
      ),
    remindInvites: (id: string, input: PublicFormRemindInput = {}) =>
      core.request<{
        data: { invites: MintedPublicFormInvite[]; sent: number; skipped: number };
      }>("POST", `${formPath(id)}/invites/remind`, input),
    revokeInvite: (id: string, inviteId: string) =>
      core.request<{ ok: boolean }>(
        "DELETE",
        `${formPath(id)}/invites/${encodeURIComponent(inviteId)}`,
      ),
    delete: (id: string) => core.request<{ ok: boolean }>("DELETE", formPath(id)),

    // The visitor's half. Public and unauthenticated — a client with no
    // session reaches all of it, which is the point.
    public: {
      render: (token: string, opts?: { lang?: string }) =>
        core.request<{ data: PublicFormRendered }>(
          "GET",
          `${publicPath(token)}${opts?.lang ? `?lang=${encodeURIComponent(opts.lang)}` : ""}`,
        ),
      upload: async (token: string, file: Blob | File, opts?: { field?: string; invite?: string }) => {
        // Multipart, so this goes around `core.request` (which sends JSON) and
        // through `core.fetch` — with `authHeaders` still applied, because an
        // invite-only form embedded in a signed-in application is a real case
        // and the visitor path must not strip a session that IS present.
        const form = new FormData();
        form.append("file", file);
        if (opts?.field) form.append("field", opts.field);
        if (opts?.invite) form.append("invite", opts.invite);
        const res = await core.fetch(`${core.opts.url}${publicPath(token)}/upload`, {
          method: "POST",
          credentials: "include",
          // Deliberately no `content-type`: the boundary is generated by the
          // runtime, and setting the header by hand omits it and makes the
          // body unparseable.
          headers: { ...core.authHeaders() },
          body: form,
        });
        if (!res.ok) {
          const errBody = (await res.json().catch(() => ({}))) as
            | { error?: { code: string; message: string; details?: unknown } }
            | undefined;
          throw new BacklexError(res.status, errBody);
        }
        return res.json();
      },
      saveDraft: (
        token: string,
        input: { data: Record<string, unknown>; step?: number; invite?: string },
      ) => core.request<unknown>("PUT", `${publicPath(token)}/draft`, input),
      discardDraft: (token: string, opts?: { invite?: string }) =>
        core.request<unknown>(
          "DELETE",
          `${publicPath(token)}/draft${opts?.invite ? `?i=${encodeURIComponent(opts.invite)}` : ""}`,
        ),
      submit: (
        token: string,
        input: {
          data: Record<string, unknown>;
          captchaToken?: string;
          turnstileToken?: string;
          invite?: string;
        },
        opts?: { lang?: string },
      ) =>
        core.request<{ data: PublicFormSubmitResult }>(
          "POST",
          `${publicPath(token)}/submit${opts?.lang ? `?lang=${encodeURIComponent(opts.lang)}` : ""}`,
          input,
        ),
    },
  };

  return forms;
};
