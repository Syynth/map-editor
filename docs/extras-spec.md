# glTF `extras` spec, version 1

The editor exports engine-agnostic glTF. Most of a map maps onto standard glTF;
what does not goes into `extras`. "Engine-agnostic" really means *other people
implementing this document*, so it is versioned and kept small.

`extrasVersion` is bumped whenever the shape of anything here changes. A
consumer that sees a higher version than it knows should refuse the file rather
than guess.

## What maps onto standard glTF

These need no extras at all, and a consumer that ignores this document entirely
still gets a correct-looking static scene.

| Feature | glTF representation |
|---|---|
| Cutouts | `alphaMode: MASK`, cutoff 0.5 |
| Pixel-art textures | `NEAREST` samplers, lossless PNG (no KTX2/Basis) |
| Lamps | `KHR_lights_punctual` |
| Glowing sprites | Emissive materials, `KHR_materials_emissive_strength` |
| Baked AO and tint | Vertex colours in `COLOR_0` |
| Repeated props | Shared meshes, or `EXT_mesh_gpu_instancing` when merging |
| Facing frames | One atlas per object, switched via `KHR_texture_transform` |

## Scene extras

On the glTF scene, under the key `mapEditor`:

```jsonc
{
  "extrasVersion": 1,
  "formatVersion": 1,          // the native project format this came from
  "name": "Sample Valley",
  "size": { "width": 36, "height": 36 },   // in tiles

  // One tile is one world unit, always. Texel density changes texture detail
  // only. A consumer that rescales geometry by this number is wrong.
  "resolutionProfile": {
    "texelDensity": 16,
    "filtering": "nearest",    // "nearest" | "linear"
    "snapToTexel": true
  },

  // The runtime is expected to enforce these. Yaw is degrees, 0 looking down
  // +Z, increasing clockwise seen from above.
  "cameraRig": {
    "yaw": 35, "pitch": 34, "distance": 26, "fov": 30,
    "bounds": {
      "yawMin": -180, "yawMax": 180,
      "pitchMin": 20, "pitchMax": 60,
      "distMin": 8, "distMax": 40
    },
    "yawSnapDeg": 0,           // 0 is continuous; 90 gives detents
    "projection": "perspective" // or "orthographic"
  },

  "atmosphere": {
    "preset": "Clear noon",
    "fog": { "color": 12441070, "near": 24, "far": 90 },
    "post": { "bloom": 0.35, "tiltShift": 0.25 },
    "sky": {
      "top": 4886996, "horizon": 12441070, "bottom": 15261903,
      "sunAzimuth": 135, "sunElevation": 55, "sunColor": 16774102
    },
    "backdrop": [
      { "sprite": "mountains", "base": -3, "height": 16,
        "radius": 80, "parallax": 0.92, "opacity": 1 }
    ]
  },

  "spawn": [18, 0, 18]
}
```

Colours are packed `0xRRGGBB` integers in sRGB.

A `yawMax - yawMin` of 360 means yaw is unbounded. A range where `yawMin >
yawMax` wraps past 180 — for example 150 to -150 is a 60-degree window centred
on the far side.

## Node extras

### Terrain and water nodes

```jsonc
{ "collision": "mesh", "walkable": true }
{ "collision": "none", "walkable": false, "water": true }
```

`collision` is one of `"none" | "box" | "cylinder" | "mesh"`.

### Image object nodes

```jsonc
{
  "kind": "imageObject",

  // Already resolved: "auto" is never exported, because the exporter knows the
  // camera bounds and the consumer should not have to re-derive the choice.
  "display": "billboardY",
  // "fixed" | "billboardY" | "billboardFull" | "crossed" | "extruded"

  "facing": {
    "count": 4,               // 1 | 2 | 4 | 8
    "mirror": true,           // left reuses the right-hand art, mirrored
    "back": "mirror",         // "none" | "mirror" | "dark" | "image"
    "transition": "flip",     // "instant" | "flip" | "crossfade"
    "durationMs": 260,
    "hysteresisDeg": 8,       // overlap before switching back, stops flicker
    "hinge": "center"         // "center" | "base" | "edge"
  },

  // Facings are packed side by side into one texture. Frame n occupies
  // u in [n * frameWidth, (n + 1) * frameWidth).
  "atlas": { "frames": 4, "layout": "horizontal", "frameWidth": 0.25 },

  "sizeTiles": [1.2, 2.2],
  "emissive": false,
  "seed": 41234,              // per-instance variation, stable across exports
  "anchorCell": [18, 16],     // null when the object is not ground-anchored
  "prefabId": null
}
```

## Behaviour a conforming runtime implements

1. **Display modes.** `fixed` leaves the node's own rotation alone.
   `billboardY` rotates it about Y to face the camera each frame.
   `billboardFull` also pitches it. `crossed` and `extruded` are baked into the
   geometry at export and need no runtime work.

2. **Facing selection.** Take the angle from the object to the camera, relative
   to the node's own Y rotation, and pick the nearest of `count` evenly spaced
   sectors starting at the front. Hold the current facing until the angle has
   passed the sector boundary by `hysteresisDeg`. With `mirror`, facings past
   halfway reuse the opposite frame with the quad's X scale negated.

   A character should substitute *its movement direction relative to the
   camera* for the camera angle. The same mechanism then covers NPCs and
   four-direction sprite sheets.

3. **The flip.** On a facing change with `transition: "flip"`, rotate the node
   a full 180 degrees about its hinge over `durationMs`, swapping the atlas
   frame as it passes 90 degrees, where the quad is edge-on and the swap cannot
   be seen. Reset the rotation at the end.

4. **Camera bounds.** Clamp to `bounds` every frame; snap yaw to `yawSnapDeg`
   when it is non-zero.

5. **Atmosphere.** Fog and ambient colours follow the sky, so applying the
   `sky` block should drive both rather than being set independently.

6. **Backdrop cards.** Each is a cylinder of `radius` around the map centre,
   its bottom edge at `base`, textured with the named sprite repeated around
   the circumference. It follows the camera by `1 - parallax`, so 0.92 means it
   lags almost entirely and reads as distant.

## Not in version 1

Deliberately absent, because the prototype does not produce them yet: prefab
definitions and overrides, engine-defined custom type instances, animated tile
timings, roof and occluder fade tagging, camera zones, and per-region
walkability. Each gets a new key and a version bump when it lands; none of them
changes the meaning of anything above.
