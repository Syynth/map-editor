import { beforeEach, describe, expect, it, vi } from 'vitest'

import { createMap } from '@map-editor/document'
import { buildExportScene, exportGltf } from './export'

// `parse` needs to be reconfigurable per test (success vs. error), and
// `vi.mock` factories are hoisted above imports, so the mock function itself
// has to be hoisted alongside it rather than declared as a normal local.
const { parseMock } = vi.hoisted(() => ({ parseMock: vi.fn() }))

vi.mock('three/examples/jsm/exporters/GLTFExporter.js', () => ({
  GLTFExporter: class {
    parse = parseMock
  },
}))

// `generateSprites`/`generateTerrainSheet` reach for `document.createElement('canvas')`
// (see textures.ts) to paint placeholder art with real 2D drawing calls. This repo
// has already ruled against giving Node a DOM to satisfy that — see the
// "No native binary dependencies for tooling" entry in docs/decision-log.md,
// which rejected `@napi-rs/canvas` for the export CLI on the same grounds:
// "shimming a DOM into node so browser code can run is the wrong direction".
// So this suite does not exercise the sprite/atlas path at all: the fixture
// map below carries zero objects, which keeps `buildExportScene` out of
// `atlasFor` (the other `document.createElement('canvas')` call site, inside
// export.ts itself) entirely. What IS covered: the terrain half of the scene
// graph (real geometry, no canvas involved) and the two behaviours #28 asks
// for — `buildExportScene` returning synchronously, and `exportGltf` wrapping
// a non-Error rejection. Pixel content, image embedding and the sprite/light
// path are not covered by this file.
vi.mock('./textures', () => ({
  generateSprites: () => ({}),
  generateTerrainSheet: () => ({}),
}))
vi.mock('./billboard', () => ({
  resolveDisplayMode: () => 'fixed',
  canvasTexture: () => ({}),
}))

beforeEach(() => {
  parseMock.mockReset()
})

describe('buildExportScene', () => {
  it('returns the scene directly rather than a promise', () => {
    // Regression guard for #28: `buildExportScene` used to be declared
    // `async` with nothing to await, which silently changed its return type
    // to `Promise<Scene>`. Revert that fix and this goes back to failing.
    const doc = createMap(4, 4, 'Sync Check')
    const result = buildExportScene(doc, { merge: false })
    expect(result).not.toBeInstanceOf(Promise)
  })

  it('builds a terrain root and no water root when the map has no water', () => {
    const doc = createMap(4, 4, 'Structure Check')
    const scene = buildExportScene(doc, { merge: false })

    const terrain = scene.children.find((child) => child.name === 'Terrain')
    const water = scene.children.find((child) => child.name === 'Water')
    expect(terrain).toBeDefined()
    expect(terrain?.children.length).toBeGreaterThan(0)
    expect(water).toBeUndefined()

    // Scene extras are the one thing every consumer (the editor's importer,
    // docs/extras-spec.md) actually reads back out.
    const extras = scene.userData.mapEditor as { extrasVersion: number; name: string }
    expect(extras.name).toBe('Structure Check')
    expect(extras.extrasVersion).toBe(1)
  })
})

describe('exportGltf', () => {
  it('wraps a non-Error rejection from the exporter in an Error', async () => {
    // Regression guard for #28: the GLTFExporter callback is typed as
    // `ErrorEvent`, not `Error`, and the old code rejected with it verbatim.
    // Revert that fix and this rejects with the plain `ErrorEvent`-shaped
    // object instead, failing the `toBeInstanceOf` assertion.
    parseMock.mockImplementation((_scene: unknown, _onDone: unknown, onError: (error: unknown) => void) => {
      onError({ message: 'boom' })
    })
    const doc = createMap(4, 4, 'Error Check')

    await expect(exportGltf(doc, { merge: false })).rejects.toBeInstanceOf(Error)
    await expect(exportGltf(doc, { merge: false })).rejects.toThrow('boom')
  })

  it('resolves to a binary blob on success', async () => {
    parseMock.mockImplementation((_scene: unknown, onDone: (result: ArrayBuffer) => void) => {
      onDone(new ArrayBuffer(4))
    })
    const doc = createMap(4, 4, 'Success Check')

    const blob = await exportGltf(doc, { merge: false })
    expect(blob.type).toBe('model/gltf-binary')
  })
})
