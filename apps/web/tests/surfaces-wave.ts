/**
 * The one multi-surface wave that is still open, named once so a deferral in
 * `sdk-surfaces` / `graphql-surfaces` / `cli-surfaces` cannot quietly point at
 * a wave that has already shipped.
 *
 * `until` used to be checked only for SHAPE (each file's `UNTIL` regex), and
 * shape is satisfied by any wave number at all — including one in the past. Two
 * entries drifted exactly that way and sat green: `tag-manager` promised
 * `wave-2` while its own prose described the wave-21 pass, and `webhooks`
 * promised `wave-19-phase-5` through the whole of wave 19 shipping without it.
 * A deferral aimed at a wave that is over is indistinguishable, in those files
 * and in CI, from one that is genuinely pending — which is the drift they exist
 * to catch, wearing their own uniform.
 *
 * It lives in a plain module rather than in one of the three specs because
 * importing a `.test.ts` from another re-registers the imported file's
 * `describe` blocks under the importer. Measured here: with graphql and cli
 * importing `sdk-surfaces.test`, a per-file run reported 17 / 37 / 39 tests
 * when the real counts are 17 / 20 / 22 — sdk's own seventeen, counted three
 * times. The combined run says 59 either way, so the total agrees with itself
 * and hides it; only the per-file numbers differ, and the inflated direction is
 * the one that looks healthy.
 *
 * When wave 21 ships, this constant moves and every surviving deferral has to
 * be re-justified against the new wave rather than inherited.
 */
export const OPEN_WAVE = "wave-21";
