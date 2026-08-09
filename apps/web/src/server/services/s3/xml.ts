/**
 * S3 speaks XML, and its clients parse it strictly.
 *
 * Two things matter here and nothing else does. Escaping has to cover the five
 * predefined entities, because an object key is user data and a key containing
 * `&` or `<` would otherwise produce a document the client cannot parse — which
 * surfaces as "the listing is broken" rather than "that one key is". And an
 * ERROR has to be an `<Error>` document with a `Code` a client recognises, not
 * our usual JSON envelope: every S3 tool branches on `NoSuchKey` vs
 * `AccessDenied` vs `NoSuchBucket`, and a JSON body makes all of them look like
 * the same unknown failure.
 */

export const escapeXml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");

export const xml = (body: string, status = 200): Response =>
  new Response(body, {
    status,
    headers: { "content-type": "application/xml" },
  });

/**
 * An S3 `<Error>` document.
 *
 * `code` is the machine-readable half every client branches on; `message` is
 * for the person reading the terminal. Both are escaped — a message can carry
 * a key, and a key can carry a `<`.
 */
export const xmlError = (code: string, message: string, status: number): Response =>
  xml(
    `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${escapeXml(code)}</Code>` +
      `<Message>${escapeXml(message)}</Message></Error>`,
    status,
  );
