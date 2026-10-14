// Constant-time string comparison for webhook signatures and shared secrets.
//
// A plain `a === b` short-circuits on the first differing byte, which leaks a
// timing side-channel. timingSafeEqual compares in constant time; it throws on
// unequal-length buffers, so the length check is done first (length is not a
// secret for fixed-size HMAC digests / configured secrets).
import { timingSafeEqual } from "node:crypto"

export function safeEqual(a: string, b: string): boolean {
  const ba = new TextEncoder().encode(a)
  const bb = new TextEncoder().encode(b)
  if (ba.length !== bb.length) return false
  return timingSafeEqual(ba, bb)
}
