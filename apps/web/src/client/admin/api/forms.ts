import { api } from "@/lib/api";
import type { Envelope } from "./types";

export interface ApiFormBlockI18n {
  label?: string;
  placeholder?: string;
  help?: string;
}

/** One statement of a matrix, answered into its own collection field. */
export interface ApiFormBlockMatrixRow {
  name: string;
  label?: string;
  i18n?: Record<string, ApiFormBlockI18n>;
}

/** One form block: a collection field, a "step" page break, or a "matrix"
 *  grid of rows sharing one set of columns. */
export interface ApiFormBlock {
  id?: string;
  kind?: "field" | "step" | "matrix";
  name?: string;
  label?: string;
  placeholder?: string;
  help?: string;
  /** @deprecated Superseded by `scale` — still accepted and still renders. */
  rating?: boolean;
  /** Integer fields only: answer by picking a point on a row. On a matrix, the
   *  shared scale every row is answered on. */
  scale?: ApiFormBlockScale;
  /** Matrix blocks: the statements the grid asks, top to bottom. Their fields
   *  are all integer (answered on `scale`) or all offer the same choices. */
  rows?: ApiFormBlockMatrixRow[];
  consent?: boolean;
  policyUrl?: string;
  /** File blocks: MIME allow-list + per-upload byte cap. */
  accept?: string[];
  maxBytes?: number;
  cond?: { field: string; op: "is" | "is_not"; value: string };
  i18n?: Record<string, ApiFormBlockI18n>;
}

/** A question answered by picking one point on a row — stars, a numbered row,
 *  or the 0–10 NPS row. Integer fields only; at most 11 points wide. */
export interface ApiFormBlockScale {
  min: number;
  max: number;
  style: "stars" | "number" | "nps";
  minLabel?: string;
  maxLabel?: string;
}

export interface ApiFormI18n {
  title?: string;
  description?: string;
  submitLabel?: string;
  successMessage?: string;
}

export interface ApiFormSettings {
  description?: string;
  submitLabel?: string;
  successMessage?: string;
  redirectUrl?: string;
  turnstile?: boolean;
  theme?: "dark" | "light";
  accent?: string;
  font?: "sans" | "lexend" | "mono" | "system";
  languages?: string[];
  i18n?: Record<string, ApiFormI18n>;
  /** Epoch ms. Outside [opensAt, closesAt) the public page shows
   *  `closedMessage` instead of the questions. */
  opensAt?: number;
  closesAt?: number;
  maxResponses?: number;
  /** One answer per browser (a cookie, not an identity). */
  onePerBrowser?: boolean;
  /** Only a visitor holding an unspent invite may answer. */
  inviteOnly?: boolean;
  /** Keep half-filled answers so a visitor can come back to them. */
  saveProgress?: boolean;
  closedMessage?: string;
}

export interface ApiForm {
  id: string;
  tenantId: string | null;
  name: string;
  collection: string;
  fields: ApiFormBlock[];
  settings: ApiFormSettings | null;
  active: boolean;
  submissionCount: number;
  blockedCount: number;
  lastSubmissionAt: unknown;
  createdBy: string | null;
  createdAt: unknown;
  updatedAt: unknown;
}

export interface ApiFormInput {
  name: string;
  collection: string;
  fields: ApiFormBlock[];
  settings?: ApiFormSettings | null;
  active?: boolean;
}

/** One-time token payload — returned only by create / rotate-token. */
export interface ApiCreatedForm {
  form: ApiForm;
  token: string;
  url: string;
  embedUrl: string;
}

export interface ApiFormEligibleField {
  name: string;
  type: string;
  label: string | null;
  required: boolean;
  choices: string[] | null;
  format: string | null;
}

/** One question's answers, summarised (`GET /api/admin/forms/:id/results`). */
export interface ApiFormResultBlock {
  name: string;
  label: string;
  type: string;
  kind:
    | "choice"
    | "multi_choice"
    | "scale"
    | "boolean"
    | "number"
    | "text"
    | "timestamp"
    | "file";
  /** Rows whose answer is not null. For `multi_choice` the bucket counts are
   *  choices, not people, so they can sum to more than this. */
  answered: number;
  buckets: { value: string; label: string; count: number }[] | null;
  average: number | null;
  nps: { promoters: number; passives: number; detractors: number; score: number } | null;
  /** Set when the question is one row of a matrix — blocks sharing an `id`
   *  were asked under one heading and are shown under it again. */
  matrix: { id: string; label: string } | null;
}

export interface ApiFormResults {
  formId: string;
  collection: string;
  /** Rows in the target collection — not only ones this form wrote. */
  rows: number;
  submissionCount: number;
  blockedCount: number;
  /** Half-filled forms saved but not submitted (0 unless `saveProgress`). */
  inProgress: number;
  lastSubmissionAt: unknown;
  blocks: ApiFormResultBlock[];
  truncated: number;
}

/** One invitation to answer a form. Read responses never carry the token. */
export interface ApiFormInvite {
  id: string;
  formId: string;
  email: string | null;
  name: string | null;
  sentAt: unknown;
  usedAt: unknown;
  /** When a reminder last went out to this person, and how many have. */
  remindedAt: unknown;
  reminderCount: number;
  createdAt: unknown;
}

/** A freshly minted invite — `token`/`url` appear only in the mint response. */
export interface ApiMintedFormInvite extends ApiFormInvite {
  token: string;
  url: string;
}

export const formsApi = {
  list: () => api<Envelope<ApiForm[]>>(`/api/admin/forms`),
  results: (id: string) => api<Envelope<ApiFormResults>>(`/api/admin/forms/${id}/results`),
  invites: (id: string) => api<Envelope<ApiFormInvite[]>>(`/api/admin/forms/${id}/invites`),
  invite: (
    id: string,
    input: {
      recipients: { email?: string; name?: string }[];
      formToken?: string;
      send?: boolean;
    },
  ) =>
    api<Envelope<{ invites: ApiMintedFormInvite[]; sent: number }>>(
      `/api/admin/forms/${id}/invites`,
      { method: "POST", body: JSON.stringify(input) },
    ),
  /** Mint a fresh link for whoever hasn't answered (earlier links keep
   *  working — every link into an invite opens the same turn). */
  remindInvites: (
    id: string,
    input: {
      inviteIds?: string[];
      formToken?: string;
      send?: boolean;
      minIntervalHours?: number;
      force?: boolean;
    } = {},
  ) =>
    api<Envelope<{ invites: ApiMintedFormInvite[]; sent: number; skipped: number }>>(
      `/api/admin/forms/${id}/invites/remind`,
      { method: "POST", body: JSON.stringify(input) },
    ),
  revokeInvite: (id: string, inviteId: string) =>
    api<{ ok: true }>(`/api/admin/forms/${id}/invites/${inviteId}`, { method: "DELETE" }),
  eligibleFields: (collection: string) =>
    api<Envelope<ApiFormEligibleField[]>>(
      `/api/admin/forms/eligible-fields/${encodeURIComponent(collection)}`,
    ),
  create: (input: ApiFormInput) =>
    api<Envelope<ApiCreatedForm>>(`/api/admin/forms`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
  update: (id: string, patch: Partial<ApiFormInput>) =>
    api<Envelope<ApiForm>>(`/api/admin/forms/${id}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),
  rotateToken: (id: string) =>
    api<Envelope<{ token: string; url: string; embedUrl: string }>>(
      `/api/admin/forms/${id}/rotate-token`,
      { method: "POST" },
    ),
  remove: (id: string) =>
    api<{ ok: true }>(`/api/admin/forms/${id}`, { method: "DELETE" }),
};

/** Public form definition (`GET /api/public/forms/:token`). */
export interface ApiPublicFormBlock {
  kind: string;
  name?: string;
  type?: string;
  label: string;
  placeholder: string | null;
  help: string | null;
  required: boolean;
  /** @deprecated True only for the legacy 1–5 star row; read `scale`. */
  rating: boolean;
  scale: ApiFormBlockScale | null;
  consent: boolean;
  policyUrl: string | null;
  choices: { value: string; label?: string }[] | null;
  /** File blocks: accepted MIME patterns (null ⇒ any) + effective byte cap. */
  accept: string[] | null;
  maxBytes: number | null;
  validation: Record<string, unknown> | null;
  cond: { field: string; op: string; value: string } | null;
  /** Non-null ⇒ one row of a matrix. Consecutive blocks sharing an `id` are
   *  drawn as one grid; each is still an ordinary field block, so a bundle
   *  that predates matrices renders them as plain rows instead. */
  matrix?: { id: string; label: string; help: string | null } | null;
}

export interface ApiPublicForm {
  name: string;
  description: string | null;
  collection: string;
  blocks: ApiPublicFormBlock[];
  submitLabel: string | null;
  successMessage: string | null;
  redirectUrl: string | null;
  theme: "dark" | "light";
  accent: string | null;
  font: "sans" | "lexend" | "mono" | "system";
  languages: string[];
  locale: string;
  turnstileSiteKey: string | null;
  /** The challenge the submit enforces — the workspace captcha when its
   *  `protect` list covers forms, else the legacy per-form Turnstile. */
  captcha: { provider: "turnstile" | "hcaptcha" | "recaptcha"; siteKey: string } | null;
  /** Non-null ⇒ the form is not taking answers right now. */
  closed: {
    reason: "scheduled" | "ended" | "full" | "answered" | "invite" | "invite_used";
    message: string;
  } | null;
  /** True ⇒ post what is filled in as it is filled in, and expect `draft`. */
  saveProgress: boolean;
  /** What this visitor left behind last time, or null for a fresh start. */
  draft: { data: Record<string, unknown>; step: number; savedAt: number } | null;
}

export interface ApiPublicFormUpload {
  /** Signed one-time ticket the submit payload carries as the field value. */
  ticket: string;
  name: string;
  size: number;
  contentType: string | null;
}

export const formsPublicApi = {
  get: (token: string, lang?: string, invite?: string) => {
    const qs = new URLSearchParams();
    if (lang) qs.set("lang", lang);
    // The invite rides on the definition read too, so an already-spent link
    // says so before anyone answers six questions they can't submit.
    if (invite) qs.set("i", invite);
    const q = qs.toString();
    return api<Envelope<ApiPublicForm>>(
      `/api/public/forms/${encodeURIComponent(token)}${q ? `?${q}` : ""}`,
    );
  },
  upload: (token: string, field: string, file: File) => {
    const fd = new FormData();
    fd.append("field", field);
    fd.append("file", file);
    return api<Envelope<ApiPublicFormUpload>>(
      `/api/public/forms/${encodeURIComponent(token)}/upload`,
      { method: "POST", body: fd },
    );
  },
  /** Save what has been filled in so far. Only forms with `saveProgress` take
   *  this; the resume key is the invite token or a cookie the server mints. */
  saveDraft: (
    token: string,
    body: { data: Record<string, unknown>; step?: number; invite?: string },
  ) =>
    api<Envelope<{ savedAt: number }>>(
      `/api/public/forms/${encodeURIComponent(token)}/draft`,
      { method: "PUT", body: JSON.stringify(body) },
    ),
  /** Throw the saved answers away — the "start over" button. */
  clearDraft: (token: string, invite?: string) =>
    api<Envelope<{ cleared: boolean }>>(
      `/api/public/forms/${encodeURIComponent(token)}/draft${invite ? `?i=${encodeURIComponent(invite)}` : ""}`,
      { method: "DELETE" },
    ),
  submit: (
    token: string,
    body: {
      data: Record<string, unknown>;
      turnstileToken?: string;
      website?: string;
      /** Single-use invite token, carried over from `?i=` on the page URL. */
      invite?: string;
    },
    lang?: string,
  ) =>
    api<Envelope<{ id: string | null; successMessage: string | null; redirectUrl: string | null }>>(
      `/api/public/forms/${encodeURIComponent(token)}/submit${lang ? `?lang=${encodeURIComponent(lang)}` : ""}`,
      { method: "POST", body: JSON.stringify(body) },
    ),
};
