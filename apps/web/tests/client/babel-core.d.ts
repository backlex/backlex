/**
 * `@babel/core` ships no types and `@types/babel__core` is not installed —
 * this loader is the only thing in the repo that touches it, and pulling a
 * whole DefinitelyTyped package in for one call is more dependency than the
 * call is worth. Declaring the one function used keeps it checked.
 */
declare module "@babel/core" {
  export function transformAsync(
    code: string,
    opts?: Record<string, unknown>,
  ): Promise<{ code?: string | null } | null>;
}
