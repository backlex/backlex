import type { ImageAdapter } from "@workeros/core";

/**
 * Default image adapter — returns the source body untouched. Used when no
 * runtime-specific provider is available (e.g. older Bun without the image
 * API, or Workers without a CF Image plan).
 */
export const passthroughImage = (): ImageAdapter => ({
  name: "passthrough",
  async transform(body, contentType) {
    return {
      body,
      contentType: contentType ?? "application/octet-stream",
    };
  },
});
