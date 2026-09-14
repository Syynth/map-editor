/**
 * Ed25519 public keys a bundle manifest may be signed by. The private half is
 * the `BUNDLE_SIGNING_KEY` secret the Pages workflow signs with.
 *
 * A list so the key can be rotated without stranding installed apps: ship a
 * shell trusting old and new, switch CI to the new key, drop the old one in a
 * later shell release.
 *
 * Empty until the first key is generated — with nothing trusted, a packaged app
 * never updates its bundle and serves the one its installer shipped.
 */
export const TRUSTED_BUNDLE_KEYS: readonly string[] = []
