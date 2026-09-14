/**
 * Ed25519 public keys a bundle manifest may be signed by. The private half is
 * the `BUNDLE_SIGNING_KEY` secret the Pages workflow signs with.
 *
 * A list so the key can be rotated without stranding installed apps: ship a
 * shell trusting old and new, switch CI to the new key, drop the old one in a
 * later shell release.
 */
export const TRUSTED_BUNDLE_KEYS: readonly string[] = [
  // Generated 2026-09-13; the private key is the repo's BUNDLE_SIGNING_KEY
  // secret, backed up in the owner's password manager.
  `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEA5HAv6PiAs4FWVnTh1fTMxW6ZqnLWQNl90E5O+7UdP0c=
-----END PUBLIC KEY-----
`,
]
