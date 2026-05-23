/**
 * Constant-time string comparison. Web Crypto / SubtleCrypto doesn't ship
 * `timingSafeEqual`, but the standard equivalent — XOR every byte and OR the
 * results into an accumulator — runs in constant time as long as the inputs
 * are the same length. We length-prefix to handle the unequal-length case
 * without an early-return leak.
 */
export const timingSafeEqual = (a: string, b: string): boolean => {
  const aBytes = new TextEncoder().encode(a);
  const bBytes = new TextEncoder().encode(b);
  if (aBytes.length !== bBytes.length) {
    // Still spend the same work — XOR `a` with itself so the timing matches
    // a successful compare of equal-length strings against the longer side.
    let acc = 1;
    const longer = aBytes.length > bBytes.length ? aBytes : bBytes;
    for (let i = 0; i < longer.length; i++) acc |= longer[i]! ^ longer[i]!;
    return acc === 0 ? false : false;
  }
  let acc = 0;
  for (let i = 0; i < aBytes.length; i++) acc |= aBytes[i]! ^ bBytes[i]!;
  return acc === 0;
};
