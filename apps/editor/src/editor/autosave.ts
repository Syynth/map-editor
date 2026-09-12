/**
 * The autosave slot in `localStorage`.
 *
 * Its own module because the two halves ended up in two places once the store
 * moved to the composition root (#66 step 4): `main.tsx` reads the slot to
 * build the document it constructs the store with, and `App.tsx` writes it on
 * a debounce as the document changes. One name for the key, one pair of
 * functions, rather than the string spelled out in both files.
 */

import { deserialize, serialize, type ReadonlyMapDoc } from '@map-editor/document'
import { createSampleMap } from '@map-editor/fixtures'

const AUTOSAVE_KEY = 'map-editor:autosave'

export function loadAutosave() {
  try {
    const text = localStorage.getItem(AUTOSAVE_KEY)
    if (text) return deserialize(text)
  } catch {
    // A corrupt or stale autosave should never stop the editor opening.
  }
  // Defaults look decent: a first run opens a landscape, not a flat plane.
  return createSampleMap()
}

export function saveAutosave(doc: ReadonlyMapDoc): void {
  try {
    localStorage.setItem(AUTOSAVE_KEY, serialize(doc))
  } catch {
    // Quota or a private window; autosave is a convenience, not a promise.
  }
}
