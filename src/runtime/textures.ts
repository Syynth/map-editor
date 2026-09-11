/**
 * Procedural placeholder art.
 *
 * The brief is strict about assets: RPG Maker's RTP must not be used, and
 * anything shipped should be CC0 or similar. Rather than vendor a third-party
 * pack into the repository to get started, the prototype draws its own
 * placeholder sheet and sprites at runtime. They are ugly on purpose — the
 * point is to exercise the template layout, not to look good — and they carry
 * no licence at all.
 *
 * The terrain sheet doubles as its own guide layer: each autotile variant
 * draws a rim on exactly the sides where it is NOT connected to a neighbour,
 * so an artist can read the layout straight off the generated sheet before
 * replacing it with real art through the sheet loader.
 */

import {
  BLOCK_COLUMNS,
  BLOCK_ROWS,
  CLIFF_ROW,
  CLIFF_BOTTOM,
  CLIFF_MIDDLE,
  CLIFF_TOP,
  RAMP_COLUMN,
} from '@map-editor/geometry'
import {
  MASK_EAST,
  MASK_NORTH,
  MASK_SOUTH,
  MASK_WEST,
  type MaterialDef,
} from '@map-editor/document'

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function shade(color: number, amount: number): string {
  const r = (color >> 16) & 0xff
  const g = (color >> 8) & 0xff
  const b = color & 0xff
  const mix = (channel: number) =>
    Math.max(0, Math.min(255, Math.round(amount >= 0 ? channel + (255 - channel) * amount : channel * (1 + amount))))
  return `rgb(${mix(r)},${mix(g)},${mix(b)})`
}

function makeCanvas(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  return canvas
}

function speckle(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  size: number,
  color: number,
  rng: () => number,
  density = 0.16,
): void {
  const count = Math.floor(size * size * density)
  for (let i = 0; i < count; i++) {
    const px = x + Math.floor(rng() * size)
    const py = y + Math.floor(rng() * size)
    ctx.fillStyle = shade(color, rng() > 0.5 ? 0.12 : -0.12)
    ctx.fillRect(px, py, 1, 1)
  }
}

/**
 * The terrain template sheet. Layout is documented in
 * packages/geometry/src/template.ts; this only draws into it.
 */
export function generateTerrainSheet(
  materials: MaterialDef[],
  density: number,
): HTMLCanvasElement {
  const canvas = makeCanvas(materials.length * BLOCK_COLUMNS * density, BLOCK_ROWS * density)
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('2D canvas unavailable')
  ctx.imageSmoothingEnabled = false

  materials.forEach((material, index) => {
    const rng = mulberry32(0x9e37 + index * 977)
    const color = material.color
    const blockX = index * BLOCK_COLUMNS * density

    // --- rows 0..3: the 16 autotile variants -------------------------------
    for (let mask = 0; mask < 16; mask++) {
      const x = blockX + (mask & 3) * density
      const y = (mask >> 2) * density

      ctx.fillStyle = shade(color, 0)
      ctx.fillRect(x, y, density, density)
      speckle(ctx, x, y, density, color, rng)

      // A rim on every side that is NOT connected. This is the guide layer.
      const rim = Math.max(1, Math.round(density / 8))
      ctx.fillStyle = shade(color, 0.3)
      if ((mask & MASK_NORTH) === 0) ctx.fillRect(x, y, density, rim)
      if ((mask & MASK_WEST) === 0) ctx.fillRect(x, y, rim, density)
      ctx.fillStyle = shade(color, -0.3)
      if ((mask & MASK_SOUTH) === 0) ctx.fillRect(x, y + density - rim, density, rim)
      if ((mask & MASK_EAST) === 0) ctx.fillRect(x + density - rim, y, rim, density)
    }

    // --- row 4: cliff bands and the ramp -----------------------------------
    const cliffY = CLIFF_ROW * density
    const rock = shade(color, -0.45)

    const drawBand = (column: number, top: number, bottom: number) => {
      const x = blockX + column * density
      const gradient = ctx.createLinearGradient(0, cliffY, 0, cliffY + density)
      gradient.addColorStop(0, shade(color, top))
      gradient.addColorStop(1, shade(color, bottom))
      ctx.fillStyle = gradient
      ctx.fillRect(x, cliffY, density, density)
      // Vertical striations read as rock strata at any resolution.
      for (let i = 0; i < Math.max(2, density / 4); i++) {
        const sx = x + Math.floor(rng() * density)
        ctx.fillStyle = shade(color, rng() > 0.5 ? -0.6 : -0.2)
        ctx.fillRect(sx, cliffY + Math.floor(rng() * density * 0.3), 1, Math.floor(density * 0.7))
      }
    }

    drawBand(CLIFF_TOP, -0.15, -0.4)
    drawBand(CLIFF_MIDDLE, -0.4, -0.5)
    drawBand(CLIFF_BOTTOM, -0.5, -0.7)

    // A lip along the top of the top band, so the cliff edge reads clearly.
    const lip = Math.max(1, Math.round(density / 8))
    ctx.fillStyle = shade(color, 0.25)
    ctx.fillRect(blockX + CLIFF_TOP * density, cliffY, density, lip)

    // Rubble at the foot of the bottom band.
    for (let i = 0; i < density / 2; i++) {
      ctx.fillStyle = rock
      ctx.fillRect(
        blockX + CLIFF_BOTTOM * density + Math.floor(rng() * density),
        cliffY + density - 1 - Math.floor(rng() * (density / 4)),
        1,
        1,
      )
    }

    // Ramp: the flat material with a tread pattern so slopes read as walkable.
    const rampX = blockX + RAMP_COLUMN * density
    ctx.fillStyle = shade(color, -0.08)
    ctx.fillRect(rampX, cliffY, density, density)
    speckle(ctx, rampX, cliffY, density, color, rng)
    const step = Math.max(2, Math.round(density / 4))
    ctx.fillStyle = shade(color, -0.28)
    for (let ty = 0; ty < density; ty += step) {
      ctx.fillRect(rampX, cliffY + ty, density, 1)
    }
  })

  return canvas
}

export interface SpriteAsset {
  name: string
  /** One canvas per facing. Index 0 faces the camera at the default yaw. */
  facings: HTMLCanvasElement[]
  /** Footprint in tiles, used to size the quad. */
  widthTiles: number
  heightTiles: number
  /** Windows and lamps glow at night. */
  emissive: boolean
}

type Painter = (ctx: CanvasRenderingContext2D, w: number, h: number, rng: () => number, facing: number) => void

function sprite(
  name: string,
  widthTiles: number,
  heightTiles: number,
  facingCount: number,
  density: number,
  paint: Painter,
  emissive = false,
): SpriteAsset {
  const w = Math.round(widthTiles * density)
  const h = Math.round(heightTiles * density)
  const facings: HTMLCanvasElement[] = []
  for (let facing = 0; facing < facingCount; facing++) {
    const canvas = makeCanvas(w, h)
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('2D canvas unavailable')
    ctx.imageSmoothingEnabled = false
    paint(ctx, w, h, mulberry32(0x1234 + name.length * 31 + facing * 7), facing)
    facings.push(canvas)
  }
  return { name, facings, widthTiles, heightTiles, emissive }
}

function px(ctx: CanvasRenderingContext2D, color: string, x: number, y: number, w = 1, h = 1): void {
  ctx.fillStyle = color
  ctx.fillRect(Math.round(x), Math.round(y), Math.max(1, Math.round(w)), Math.max(1, Math.round(h)))
}

/**
 * The placeholder sprite library. Deliberately includes objects with one, two
 * and four facings, because the coverage readout in section 11 only means
 * anything if the map contains a mix.
 */
export function generateSprites(density: number): Record<string, SpriteAsset> {
  const assets: SpriteAsset[] = [
    sprite('tree', 1.6, 2.4, 1, density, (ctx, w, h, rng) => {
      px(ctx, '#5a3a22', w / 2 - w * 0.07, h * 0.62, w * 0.15, h * 0.38)
      const cx = w / 2
      for (let layer = 0; layer < 3; layer++) {
        const ly = h * (0.14 + layer * 0.19)
        const lw = w * (0.34 + layer * 0.15)
        ctx.fillStyle = layer === 0 ? '#4e8f3f' : layer === 1 ? '#3f7a33' : '#356b2c'
        ctx.beginPath()
        ctx.moveTo(cx, ly - h * 0.12)
        ctx.lineTo(cx - lw, ly + h * 0.14)
        ctx.lineTo(cx + lw, ly + h * 0.14)
        ctx.closePath()
        ctx.fill()
      }
      for (let i = 0; i < 14; i++) {
        px(ctx, '#6aa84f', rng() * w, h * 0.1 + rng() * h * 0.5)
      }
    }),

    sprite('bush', 1.1, 0.8, 1, density, (ctx, w, h, rng) => {
      ctx.fillStyle = '#3f7a33'
      ctx.beginPath()
      ctx.ellipse(w / 2, h * 0.65, w * 0.45, h * 0.4, 0, 0, Math.PI * 2)
      ctx.fill()
      for (let i = 0; i < 10; i++) px(ctx, '#5a9c48', rng() * w, h * 0.3 + rng() * h * 0.5)
    }),

    sprite('rock', 1.1, 0.9, 1, density, (ctx, w, h, rng) => {
      ctx.fillStyle = '#8e8e8e'
      ctx.beginPath()
      ctx.moveTo(w * 0.1, h)
      ctx.lineTo(w * 0.24, h * 0.32)
      ctx.lineTo(w * 0.58, h * 0.14)
      ctx.lineTo(w * 0.9, h * 0.46)
      ctx.lineTo(w * 0.86, h)
      ctx.closePath()
      ctx.fill()
      ctx.fillStyle = '#a8a8a8'
      ctx.fillRect(w * 0.3, h * 0.3, w * 0.2, h * 0.16)
      for (let i = 0; i < 8; i++) px(ctx, '#707070', w * 0.2 + rng() * w * 0.6, h * 0.3 + rng() * h * 0.6)
    }),

    sprite('lamp', 0.7, 2.0, 1, density, (ctx, w, h) => {
      px(ctx, '#3b3b44', w / 2 - w * 0.1, h * 0.24, w * 0.2, h * 0.76)
      px(ctx, '#2c2c33', w * 0.2, h * 0.96, w * 0.6, h * 0.04)
      ctx.fillStyle = '#ffd88a'
      ctx.beginPath()
      ctx.ellipse(w / 2, h * 0.16, w * 0.34, h * 0.11, 0, 0, Math.PI * 2)
      ctx.fill()
      px(ctx, '#fff6dd', w / 2 - w * 0.12, h * 0.12, w * 0.24, h * 0.06)
    }, true),

    sprite('barrel', 0.9, 1.1, 1, density, (ctx, w, h) => {
      px(ctx, '#8a5f33', w * 0.16, h * 0.12, w * 0.68, h * 0.84)
      px(ctx, '#6d4a27', w * 0.16, h * 0.3, w * 0.68, h * 0.07)
      px(ctx, '#6d4a27', w * 0.16, h * 0.66, w * 0.68, h * 0.07)
      px(ctx, '#a0743f', w * 0.24, h * 0.12, w * 0.12, h * 0.84)
    }),

    // Two sides that genuinely differ, to exercise the front/back setting.
    sprite('sign', 1.2, 1.3, 2, density, (ctx, w, h, _rng, facing) => {
      px(ctx, '#6b4a2a', w / 2 - w * 0.06, h * 0.52, w * 0.12, h * 0.48)
      px(ctx, facing === 0 ? '#c9a36a' : '#9c7c4d', w * 0.1, h * 0.1, w * 0.8, h * 0.46)
      if (facing === 0) {
        for (let i = 0; i < 3; i++) px(ctx, '#4a3520', w * 0.2, h * (0.2 + i * 0.1), w * 0.5, h * 0.04)
      } else {
        px(ctx, '#7a5f3a', w * 0.18, h * 0.18, w * 0.64, h * 0.3)
      }
    }),

    // Four facings: the case the coverage readout is really about.
    sprite('statue', 1.2, 2.2, 4, density, (ctx, w, h, _rng, facing) => {
      px(ctx, '#9aa0a6', w * 0.2, h * 0.88, w * 0.6, h * 0.12)
      px(ctx, '#b6bcc2', w * 0.3, h * 0.3, w * 0.4, h * 0.6)
      ctx.fillStyle = '#c8ced4'
      ctx.beginPath()
      ctx.ellipse(w / 2, h * 0.22, w * 0.17, h * 0.1, 0, 0, Math.PI * 2)
      ctx.fill()
      // Front has a face; the sides have an arm; the back has neither.
      if (facing === 0) {
        px(ctx, '#5b6169', w * 0.42, h * 0.2, w * 0.05, h * 0.03)
        px(ctx, '#5b6169', w * 0.55, h * 0.2, w * 0.05, h * 0.03)
      } else if (facing === 1 || facing === 3) {
        px(ctx, '#aab0b6', facing === 1 ? w * 0.66 : w * 0.22, h * 0.36, w * 0.12, h * 0.34)
      }
    }),

    // A character, for play mode. Four directions, the RPG Maker convention.
    sprite('hero', 1.0, 1.5, 4, density, (ctx, w, h, _rng, facing) => {
      const shirt = ['#3f6fd8', '#3f6fd8', '#2f55a8', '#3f6fd8'][facing]
      px(ctx, '#2b2b33', w * 0.33, h * 0.84, w * 0.14, h * 0.16)
      px(ctx, '#2b2b33', w * 0.53, h * 0.84, w * 0.14, h * 0.16)
      px(ctx, shirt, w * 0.28, h * 0.42, w * 0.44, h * 0.44)
      ctx.fillStyle = '#e8b98c'
      ctx.beginPath()
      ctx.ellipse(w / 2, h * 0.28, w * 0.22, h * 0.19, 0, 0, Math.PI * 2)
      ctx.fill()
      px(ctx, '#6b4a2a', w * 0.28, h * 0.1, w * 0.44, h * 0.14)
      if (facing === 0) {
        px(ctx, '#2b2b33', w * 0.38, h * 0.28, w * 0.06, h * 0.05)
        px(ctx, '#2b2b33', w * 0.56, h * 0.28, w * 0.06, h * 0.05)
      } else if (facing === 1) {
        px(ctx, '#2b2b33', w * 0.58, h * 0.28, w * 0.06, h * 0.05)
      } else if (facing === 3) {
        px(ctx, '#2b2b33', w * 0.36, h * 0.28, w * 0.06, h * 0.05)
      }
    }),

    // A backdrop card: painted distant scenery, the no-modeling answer to
    // far-off mountains.
    sprite('mountains', 16, 4, 1, density, (ctx, w, h, rng) => {
      for (let layer = 2; layer >= 0; layer--) {
        const base = h * (0.72 + layer * 0.1)
        ctx.fillStyle = ['#6f7fa6', '#5c6b91', '#49577a'][layer]
        ctx.beginPath()
        ctx.moveTo(0, h)
        let x = 0
        ctx.lineTo(0, base)
        while (x < w) {
          const peak = base - rng() * h * (0.35 + layer * 0.18)
          const span = w * (0.05 + rng() * 0.07)
          ctx.lineTo(x + span / 2, peak)
          ctx.lineTo(x + span, base - rng() * h * 0.05)
          x += span
        }
        ctx.lineTo(w, h)
        ctx.closePath()
        ctx.fill()
      }
    }),
  ]

  const library: Record<string, SpriteAsset> = {}
  for (const asset of assets) library[asset.name] = asset
  return library
}

export const SPRITE_NAMES = [
  'tree',
  'bush',
  'rock',
  'lamp',
  'barrel',
  'sign',
  'statue',
  'hero',
] as const
