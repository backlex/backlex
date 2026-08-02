/**
 * Assemble a raw MIME message.
 *
 * Exists for exactly one reason: Amazon SES's `Simple` content shape has no
 * attachment field, so an email carrying a calendar invite has to be handed to
 * SES as `Raw` — a complete, base64'd MIME document. Every other transport here
 * takes attachments through its own JSON or form API and never touches this.
 *
 * Deliberately minimal. It builds the one structure that is needed
 * (`multipart/mixed` wrapping an optional `multipart/alternative` body plus N
 * files) rather than a general MIME library, because the parts that go wrong in
 * a general one — header folding, nested boundaries, 8-bit transfer encodings —
 * are all avoidable by encoding everything as base64 and never nesting deeper
 * than two levels.
 */
import type { EmailAttachment } from "@backlex/core";

/** Encode a UTF-8 string as base64 without pulling in Node's Buffer — this
 *  file runs on Workers too. */
const b64 = (s: string): string => {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
};

/** base64 wants a line break every 76 characters; some MTAs reject longer. */
const wrap = (s: string): string => (s.match(/.{1,76}/g) ?? []).join("\r\n");

/**
 * RFC 2047 encoded-word.
 *
 * A subject line is the one header a user controls, and this codebase's users
 * write Turkish. Non-ASCII bytes in a raw header are not merely discouraged —
 * they are undefined, and the practical result is a mangled subject.
 */
const header = (v: string): string =>
  // eslint-disable-next-line no-control-regex
  /^[\x20-\x7e]*$/.test(v) ? v : `=?utf-8?B?${b64(v)}?=`;

/**
 * Strip anything that could inject a header.
 *
 * `to`/`from` reach here from templates and flow interpolation, so a value
 * carrying a CRLF would let the caller append their own headers — a Bcc, a
 * different Reply-To — to a message the operator believes they authored.
 */
const oneLine = (v: string): string => v.replace(/[\r\n]+/g, " ").trim();

/**
 * A filename that is safe inside a quoted header parameter.
 *
 * CRLF is already gone via {@link oneLine}, so this is not about header
 * injection — it is that an embedded `"` would close the quoted string early
 * and leave the rest of the name looking like parameters. The filename reaches
 * here from flow interpolation, so it is not the author's literal.
 */
const quotable = (v: string): string => oneLine(v).replace(/["\\]/g, "");

/** Boundaries must not appear in the content they delimit. Random and long
 *  enough that they do not, and never derived from the body. */
const boundary = (tag: string): string =>
  `----=_backlex_${tag}_${crypto.randomUUID().replace(/-/g, "")}`;

export interface RawMessage {
  from: string;
  to: string;
  subject: string;
  text: string;
  html?: string;
  attachments?: EmailAttachment[];
}

/** Build the complete MIME document, CRLF-terminated throughout. */
export function buildRawMime(msg: RawMessage): string {
  const mixed = boundary("mix");
  const alt = boundary("alt");
  const files = msg.attachments ?? [];

  const bodyParts: string[] = [];
  if (msg.html) {
    // `multipart/alternative` orders parts least- to most-preferred, so the
    // plain text goes FIRST. Reversed, every client shows the fallback.
    bodyParts.push(
      `Content-Type: multipart/alternative; boundary="${alt}"`,
      "",
      `--${alt}`,
      "Content-Type: text/plain; charset=utf-8",
      "Content-Transfer-Encoding: base64",
      "",
      wrap(b64(msg.text)),
      `--${alt}`,
      "Content-Type: text/html; charset=utf-8",
      "Content-Transfer-Encoding: base64",
      "",
      wrap(b64(msg.html)),
      `--${alt}--`,
    );
  } else {
    bodyParts.push(
      "Content-Type: text/plain; charset=utf-8",
      "Content-Transfer-Encoding: base64",
      "",
      wrap(b64(msg.text)),
    );
  }

  const lines: string[] = [
    `From: ${oneLine(msg.from)}`,
    `To: ${oneLine(msg.to)}`,
    `Subject: ${header(oneLine(msg.subject))}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${mixed}"`,
    "",
    `--${mixed}`,
    ...bodyParts,
  ];

  for (const f of files) {
    const name = header(quotable(f.filename));
    lines.push(
      `--${mixed}`,
      `Content-Type: ${f.contentType ?? "application/octet-stream"}; name="${name}"`,
      "Content-Transfer-Encoding: base64",
      `Content-Disposition: attachment; filename="${name}"`,
      "",
      // Already base64 by contract; only the line length needs fixing.
      wrap(f.content.replace(/\s+/g, "")),
    );
  }

  lines.push(`--${mixed}--`, "");
  return lines.join("\r\n");
}

/** The whole message, base64'd — the shape SES's `Raw.Data` wants. */
export const rawMimeBase64 = (msg: RawMessage): string => b64(buildRawMime(msg));
