/**
 * Something in the level a caller can point at by id: an object, or a
 * structure of any kind. What the editor SELECTS is defined above this
 * package (`editor-host`'s `Selection`), and each of its kinds lives in one
 * of these — a sketch point in its sketch — so a highlight, a framing or a
 * pick that takes a target serves every selection kind without knowing them.
 */
export type DocumentTarget = { readonly kind: 'object'; readonly id: string } | { readonly kind: 'structure'; readonly id: string }
