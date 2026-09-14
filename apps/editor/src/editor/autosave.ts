/**
 * The autosave slot in `localStorage`.
 *
 * Its own module because the two halves ended up in two places once the store
 * moved to the composition root (#66 step 4): `main.tsx` reads the slot to
 * build the document it constructs the store with, and `App.tsx` writes it on
 * a debounce as the document changes. One name for the key, one pair of
 * functions, rather than the string spelled out in both files.
 */

import { deserialize, parseProject, serialize, serializeProject, type ProjectDoc, type ReadonlyMapDoc, type ReadonlyProjectDoc } from '@papercut/document'
import { createSampleMap, createSampleProject } from '@papercut/fixtures'

const AUTOSAVE_KEY = 'papercut:autosave'
const PROJECT_AUTOSAVE_KEY = 'papercut:autosave-project'

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

/** The project the map belongs to, from its own slot; the sample's when there is none. Until the project lives on disk (phase 2 of the project work), this is where its settings persist in the browser. */
export function loadAutosaveProject(): ProjectDoc {
  try {
    const text = localStorage.getItem(PROJECT_AUTOSAVE_KEY)
    if (text) return parseProject(text)
  } catch {
    // As for the map: a stale project slot should never stop the editor opening.
  }
  return createSampleProject()
}

export function saveAutosaveProject(project: ReadonlyProjectDoc): void {
  try {
    localStorage.setItem(PROJECT_AUTOSAVE_KEY, serializeProject(project))
  } catch {
    // Quota or a private window; autosave is a convenience, not a promise.
  }
}

export function saveAutosave(doc: ReadonlyMapDoc): void {
  try {
    localStorage.setItem(AUTOSAVE_KEY, serialize(doc))
  } catch {
    // Quota or a private window; autosave is a convenience, not a promise.
  }
}
