/**
 * @module
 *
 * The pieces every backlex example needs and none of them should own.
 *
 * Four example SPAs each carried a byte-identical `SetupCheck.tsx`, a
 * near-identical `env.ts`, and an 86-line sign-in form that differed by about
 * four lines. That is not a tidiness problem: an example is a claim about how
 * the product is used, and four copies of the same claim drift into four
 * slightly different recommendations.
 *
 * What is here is what is genuinely the same everywhere. What is NOT here is
 * anything that shows off a feature — each example still writes its own
 * screens, because that is the thing it exists to demonstrate.
 */
export { AuthForm, Centered, Field, type ExampleUser } from "./AuthForm";
export { SetupCheck } from "./SetupCheck";
export { API_URL, ENV, WORKSPACE, missingRequired, type EnvSpec } from "./env";
