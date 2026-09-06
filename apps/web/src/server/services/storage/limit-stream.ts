import { AppError } from "@backlex/core";

/**
 * Cap a body by what it actually SENDS, not by what it says it will send.
 *
 * Every byte ceiling on the storage paths used to be a `content-length` check,
 * and `content-length` is chosen by the other end. Two live consequences:
 *
 *  - `PUT /api/storage/:key` with `Transfer-Encoding: chunked` declared no
 *    length at all, so `assertStorageWithinLimit` was handed `0` and the
 *    workspace quota did not apply — while the fs adapter materialised the
 *    whole stream into one `Buffer` before writing a byte, so the process RSS
 *    tracked the upload.
 *  - `/from-url` fetches a URL the CALLER chose, so the `content-length` on the
 *    response is the attacker's own header. Serving the body chunked skipped
 *    both `MAX_IMPORT_BYTES` and the quota pre-check.
 *
 * The stream errors the moment the cap is crossed, so the excess is never
 * buffered and never written. `AppError("VALIDATION")` rather than a plain
 * Error so it leaves as a 422 naming the limit, and so a `put` that has already
 * begun aborts with a message rather than a truncated object.
 */
export const limitStream = (
  body: ReadableStream<Uint8Array>,
  maxBytes: number,
  label = "Body",
): ReadableStream<Uint8Array> => {
  let seen = 0;
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        seen += chunk.byteLength;
        if (seen > maxBytes) {
          controller.error(
            new AppError("VALIDATION", `${label} exceeds the ${maxBytes}-byte limit`),
          );
          return;
        }
        controller.enqueue(chunk);
      },
    }),
  );
};

/**
 * Refuse an over-declared `content-length` before reading anything.
 *
 * Cheap, and it turns the common honest case into a 413 that costs no transfer.
 * It is NOT the guard — a caller that lies, or sends chunked, walks past it,
 * which is what {@link limitStream} is for. Both, always: the header check
 * saves the bandwidth and the stream check is the one that holds.
 */
export const assertDeclaredLengthWithin = (
  contentLength: string | null | undefined,
  maxBytes: number,
  label = "Body",
): void => {
  if (!contentLength) return;
  const declared = Number(contentLength);
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new AppError(
      "VALIDATION",
      `${label} declares ${declared} bytes; the limit is ${maxBytes}`,
    );
  }
};
