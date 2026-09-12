/**
 * glTF export.
 *
 * The exporter takes the same buffers the editor previews, so what ships is
 * what was on screen. Anything glTF cannot express goes into `extras`, which
 * is documented as a small versioned spec in docs/extras-spec.md — because
 * "engine-agnostic" really means other people implementing that spec.
 *
 * glTF is strictly an output. Nothing round-trips back into editable data.
 *
 * Like the scene, the exporter draws nothing (#47): the sheet and sprites are
 * required inputs, and the one step that needs an image codec — PNG-encoding
 * the embedded textures — is a function the caller supplies. The editor hands
 * in a canvas; a headless caller hands in a pure-JS encoder.
 */

import * as THREE from 'three'
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js'

import {
  rootVoxel,
  allChunkKeys,
  type ReadonlyMapDoc,
  type RgbaImage,
  type SpriteAsset,
} from '@map-editor/document'
import { meshTerrainChunk, type MeshBuffers } from '@map-editor/geometry'
import { resolveDisplayMode, rgbaTexture } from './billboard'
import { atlasFor, embedPngImages, type PngEncoder } from './images'

/** Bump when the shape of anything under `extras` changes. */
export const EXTRAS_VERSION = 1

export interface ExportOptions {
  /** Merge static geometry per chunk for fewer draw calls, losing identity. */
  merge: boolean
  /** The template sheet the terrain samples — generated or the artist's. */
  sheet: RgbaImage
  /** Keyed by `MapObject.sprite`; an unknown name falls back to `rock`. */
  sprites: Record<string, SpriteAsset>
  /** Encodes each embedded texture. See `PngEncoder` for who supplies what. */
  encodePng: PngEncoder
}

function geometryFrom(buffers: MeshBuffers): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(buffers.positions, 3))
  geometry.setAttribute('normal', new THREE.BufferAttribute(buffers.normals, 3))
  geometry.setAttribute('uv', new THREE.BufferAttribute(buffers.uvs, 2))
  // Baked AO and tint travel as COLOR_0, exactly as the mapping table says.
  geometry.setAttribute('color', new THREE.BufferAttribute(buffers.colors, 3))
  geometry.setIndex(new THREE.BufferAttribute(buffers.indices, 1))
  return geometry
}

function spriteExtras(asset: SpriteAsset, doc: ReadonlyMapDoc, object: ReadonlyMapDoc['objects'][string]) {
  return {
    kind: 'imageObject',
    display: resolveDisplayMode(object, doc.camera),
    facing: {
      count: object.facing.facings,
      mirror: object.facing.mirror,
      back: object.facing.back,
      transition: object.facing.transition,
      durationMs: object.facing.durationMs,
      hysteresisDeg: object.facing.hysteresisDeg,
      hinge: object.facing.hinge,
    },
    // One atlas per object; the runtime picks a facing by switching UVs.
    atlas: {
      frames: asset.facings.length,
      layout: 'horizontal',
      frameWidth: 1 / asset.facings.length,
    },
    sizeTiles: [asset.widthTiles * object.scale, asset.heightTiles * object.scale],
    emissive: asset.emissive,
    seed: object.seed,
    anchorCell: object.anchorCell,
    prefabId: null,
  }
}

// Synchronous: nothing here awaits. An async signature that never suspends
// only costs the caller a microtask tick, but it also lied about the return
// type, which is the thing #28 flagged.
export function buildExportScene(doc: ReadonlyMapDoc, options: ExportOptions): THREE.Scene {
  const scene = new THREE.Scene()
  scene.name = doc.name
  const nearest = doc.filtering === 'nearest'

  // --- terrain --------------------------------------------------------------
  const sheetTexture = rgbaTexture(options.sheet, nearest)
  const terrainMaterial = new THREE.MeshStandardMaterial({
    map: sheetTexture,
    vertexColors: true,
    roughness: 1,
    metalness: 0,
    // Cutouts map onto glTF alphaMode MASK.
    alphaTest: 0.5,
    transparent: false,
  })
  terrainMaterial.name = 'terrain'

  const terrainRoot = new THREE.Group()
  terrainRoot.name = 'Terrain'
  const waterRoot = new THREE.Group()
  waterRoot.name = 'Water'

  const mergedPositions: THREE.BufferGeometry[] = []

  // TRANSITIONAL: the export walks the root voxel volume's chunks.
  const ground = rootVoxel(doc)
  for (const key of allChunkKeys(ground.size.width, ground.size.height)) {
    const mesh = meshTerrainChunk(doc, ground, key)
    if (mesh.solid.triangleCount > 0) {
      const geometry = geometryFrom(mesh.solid)
      if (options.merge) {
        mergedPositions.push(geometry)
      } else {
        const node = new THREE.Mesh(geometry, terrainMaterial)
        node.name = `terrain_${key}`
        node.userData = { collision: 'mesh', walkable: true }
        terrainRoot.add(node)
      }
    }
    if (mesh.water) {
      const water = new THREE.Mesh(
        geometryFrom(mesh.water),
        new THREE.MeshStandardMaterial({
          color: 0x3f7fb0,
          transparent: true,
          opacity: 0.66,
          roughness: 0.25,
        }),
      )
      water.name = `water_${key}`
      water.userData = { collision: 'none', walkable: false, water: true }
      waterRoot.add(water)
    }
  }

  if (options.merge && mergedPositions.length > 0) {
    // Merging by hand rather than pulling in BufferGeometryUtils: the
    // attributes are known and identical across chunks.
    let vertexCount = 0
    let indexCount = 0
    for (const geometry of mergedPositions) {
      vertexCount += geometry.getAttribute('position').count
      indexCount += geometry.getIndex()?.count ?? 0
    }
    const positions = new Float32Array(vertexCount * 3)
    const normals = new Float32Array(vertexCount * 3)
    const uvs = new Float32Array(vertexCount * 2)
    const colors = new Float32Array(vertexCount * 3)
    const indices = new Uint32Array(indexCount)
    let vertexOffset = 0
    let indexOffset = 0
    for (const geometry of mergedPositions) {
      const position = geometry.getAttribute('position')
      positions.set(position.array, vertexOffset * 3)
      normals.set(geometry.getAttribute('normal').array, vertexOffset * 3)
      uvs.set(geometry.getAttribute('uv').array, vertexOffset * 2)
      colors.set(geometry.getAttribute('color').array, vertexOffset * 3)
      const index = geometry.getIndex()
      if (index) {
        for (let i = 0; i < index.count; i++) indices[indexOffset + i] = index.getX(i) + vertexOffset
        indexOffset += index.count
      }
      vertexOffset += position.count
      geometry.dispose()
    }
    const merged = new THREE.BufferGeometry()
    merged.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    merged.setAttribute('normal', new THREE.BufferAttribute(normals, 3))
    merged.setAttribute('uv', new THREE.BufferAttribute(uvs, 2))
    merged.setAttribute('color', new THREE.BufferAttribute(colors, 3))
    merged.setIndex(new THREE.BufferAttribute(indices, 1))
    const node = new THREE.Mesh(merged, terrainMaterial)
    node.name = 'terrain_merged'
    node.userData = { collision: 'mesh', walkable: true }
    terrainRoot.add(node)
  }

  scene.add(terrainRoot)
  if (waterRoot.children.length > 0) scene.add(waterRoot)

  // --- objects --------------------------------------------------------------
  const sprites = options.sprites
  const objectRoot = new THREE.Group()
  objectRoot.name = 'Objects'

  for (const id of doc.objectOrder) {
    const object = doc.objects[id]
    if (!object || object.hidden) continue
    const asset = sprites[object.sprite] ?? sprites.rock
    const texture = rgbaTexture(atlasFor(asset), nearest)

    const width = asset.widthTiles * object.scale
    const height = asset.heightTiles * object.scale
    const geometry = new THREE.PlaneGeometry(width, height)
    geometry.translate(0, height / 2, 0)

    // Show only the first frame; the runtime switches via KHR_texture_transform.
    if (asset.facings.length > 1) {
      const uv = geometry.getAttribute('uv') as THREE.BufferAttribute
      for (let i = 0; i < uv.count; i++) uv.setX(i, uv.getX(i) / asset.facings.length)
      uv.needsUpdate = true
    }

    const material = new THREE.MeshStandardMaterial({
      map: texture,
      alphaTest: 0.5,
      side: THREE.DoubleSide,
      roughness: 1,
      metalness: 0,
      emissiveMap: asset.emissive ? texture : null,
      emissive: asset.emissive ? new THREE.Color(0xffd9a0) : new THREE.Color(0x000000),
      emissiveIntensity: asset.emissive ? 1.6 : 0,
    })
    material.name = `sprite_${object.sprite}`

    const node = new THREE.Mesh(geometry, material)
    node.name = object.name || id
    node.position.set(...object.position)
    node.rotation.y = object.rotationY * (Math.PI / 180)
    node.castShadow = true
    node.receiveShadow = true
    node.userData = spriteExtras(asset, doc, object)
    objectRoot.add(node)

    // A lamp carries its own light, per KHR_lights_punctual.
    if (asset.emissive) {
      const light = new THREE.PointLight(0xffce8a, 3.2 * object.scale, 9, 1.6)
      light.name = `${node.name}_light`
      light.position.set(
        object.position[0],
        object.position[1] + asset.heightTiles * object.scale * 0.86,
        object.position[2],
      )
      objectRoot.add(light)
    }
  }

  scene.add(objectRoot)

  // --- scene extras ---------------------------------------------------------
  scene.userData = {
    mapEditor: {
      extrasVersion: EXTRAS_VERSION,
      formatVersion: doc.formatVersion,
      name: doc.name,
      size: rootVoxel(doc).size,
      resolutionProfile: {
        texelDensity: doc.texelDensity,
        filtering: doc.filtering,
        snapToTexel: doc.filtering === 'nearest',
      },
      cameraRig: doc.camera,
      atmosphere: {
        preset: doc.atmosphere.preset,
        fog: {
          color: doc.atmosphere.fogColor,
          near: doc.atmosphere.fogNear,
          far: doc.atmosphere.fogFar,
        },
        post: { bloom: doc.atmosphere.bloom, tiltShift: doc.atmosphere.tiltShift },
        sky: {
          top: doc.atmosphere.skyTop,
          horizon: doc.atmosphere.skyHorizon,
          bottom: doc.atmosphere.skyBottom,
          sunAzimuth: doc.atmosphere.sunAzimuth,
          sunElevation: doc.atmosphere.sunElevation,
          sunColor: doc.atmosphere.sunColor,
        },
        backdrop: doc.atmosphere.backdrop,
      },
      spawn: [rootVoxel(doc).size.width / 2, 0, rootVoxel(doc).size.height / 2],
    },
  }

  return scene
}

function messageOf(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'message' in error && typeof error.message === 'string') {
    return error.message
  }
  return 'glTF export failed'
}

/**
 * Resolves to the `.glb` bytes. An `ArrayBuffer` rather than a `Blob` because
 * `Blob` is a DOM type and this package compiles without `DOM`; the editor
 * wraps it for download, a CLI would write it to disk.
 */
export async function exportGltf(doc: ReadonlyMapDoc, options: ExportOptions): Promise<ArrayBuffer> {
  const scene = buildExportScene(doc, options)
  const exporter = new GLTFExporter()
  exporter.register(embedPngImages(options.encodePng))

  return new Promise<ArrayBuffer>((resolve, reject) => {
    exporter.parse(
      scene,
      (result) => resolve(result as ArrayBuffer),
      // The typings call this an `ErrorEvent` — a DOM type this package cannot
      // even see now (#47), and not what arrives anyway: three's own exporter
      // rejects with whatever `writeAsync` threw, which is usually already an
      // `Error` — but rejecting with a non-Error, unobserved by any test, is
      // exactly what #28 flagged. When it's a string (three's `.catch(onError)`
      // passes one straight through), there is no `.message` and the result
      // would otherwise be an empty `Error` with no clue what failed — so fall
      // back to a fixed message rather than surface that.
      (error: unknown) => reject(error instanceof Error ? error : new Error(messageOf(error))),
      {
        binary: true,
        includeCustomExtensions: true,
        // Lossless PNG; the mapping table is explicit about avoiding KTX2 and
        // Basis, which would smear pixel art. The encoding itself is
        // `options.encodePng`'s, via the plugin registered above.
        embedImages: true,
      },
    )
  })
}
