// PROTOTYPE — throwaway. Procedural stand-ins for the two materials' textures
// (fill, rim; wall body, top edge, bottom edge), pixel-art sized so tiling
// and band widths read the way real Kenney-style art would. Nothing here is
// meant to survive the lab.
import * as THREE from 'three'

type Kind = 'fill' | 'rim' | 'body' | 'top' | 'bottom'

function rng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 0x100000000
  }
}

function canvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  const ctx = c.getContext('2d')
  if (!ctx) throw new Error('no 2d context')
  return [c, ctx]
}

function speckle(ctx: CanvasRenderingContext2D, r: () => number, w: number, h: number, colors: string[], count: number, size = 1): void {
  for (let i = 0; i < count; i++) {
    ctx.fillStyle = colors[Math.floor(r() * colors.length)]
    ctx.fillRect(Math.floor(r() * w), Math.floor(r() * h), size, size)
  }
}

function draw(kind: Kind): HTMLCanvasElement {
  const r = rng(kind.length * 7919 + kind.charCodeAt(0))
  switch (kind) {
    case 'fill': {
      const [c, ctx] = canvas(64, 64)
      ctx.fillStyle = '#5f9c3f'
      ctx.fillRect(0, 0, 64, 64)
      speckle(ctx, r, 64, 64, ['#69a847', '#558f38', '#72b04f'], 420)
      speckle(ctx, r, 64, 64, ['#4d8432'], 40, 2)
      return c
    }
    case 'body': {
      const [c, ctx] = canvas(64, 64)
      ctx.fillStyle = '#8a6a48'
      ctx.fillRect(0, 0, 64, 64)
      speckle(ctx, r, 64, 64, ['#95744f', '#7d5f40', '#a07c55'], 500)
      // strata lines: the wall reads as cut earth, not noise
      ctx.fillStyle = '#7a5c3e'
      for (let y = 6; y < 64; y += 14) ctx.fillRect(0, y + Math.floor(r() * 3), 64, 1)
      speckle(ctx, r, 64, 64, ['#6b5038'], 30, 2)
      return c
    }
    case 'rim': {
      // v = 1 is the outline side. Brighter tufts at the lip, fading into the fill inward.
      const [c, ctx] = canvas(128, 32)
      ctx.fillStyle = '#5f9c3f'
      ctx.fillRect(0, 0, 128, 32)
      for (let y = 0; y < 32; y++) {
        const t = y / 31 // 0 = top of image (v=1, outer)
        ctx.fillStyle = `rgba(122,184,84,${(1 - t) * 0.9})`
        ctx.fillRect(0, y, 128, 1)
      }
      for (let x = 0; x < 128; x += 4) {
        const h = 3 + Math.floor(r() * 5)
        ctx.fillStyle = '#7fc25a'
        ctx.fillRect(x, 0, 2, h)
      }
      ctx.fillStyle = '#3f7a2a'
      ctx.fillRect(0, 0, 128, 1)
      return c
    }
    case 'top': {
      // v = 1 is the top (meets the cap): grass overhang, a shadow line, then dirt.
      const [c, ctx] = canvas(128, 32)
      ctx.fillStyle = '#8a6a48'
      ctx.fillRect(0, 0, 128, 32)
      speckle(ctx, r, 128, 32, ['#95744f', '#7d5f40'], 400)
      ctx.fillStyle = '#5a4230'
      ctx.fillRect(0, 10, 128, 3)
      ctx.fillStyle = '#4d8432'
      ctx.fillRect(0, 0, 128, 8)
      for (let x = 0; x < 128; x += 3) {
        const h = 8 + Math.floor(r() * 6)
        ctx.fillStyle = r() < 0.5 ? '#5f9c3f' : '#69a847'
        ctx.fillRect(x, 0, 2, h)
      }
      return c
    }
    case 'bottom': {
      // v = 0 is the bottom (meets the ground): a dark seam with pebbles, dirt above.
      const [c, ctx] = canvas(128, 32)
      ctx.fillStyle = '#8a6a48'
      ctx.fillRect(0, 0, 128, 32)
      speckle(ctx, r, 128, 32, ['#95744f', '#7d5f40'], 400)
      for (let y = 20; y < 32; y++) {
        const t = (y - 20) / 11
        ctx.fillStyle = `rgba(60,42,28,${t * 0.85})`
        ctx.fillRect(0, y, 128, 1)
      }
      speckle(ctx, r, 128, 12, ['#6f7580', '#8a8f99'], 24, 2)
      // shift the pebbles to the bottom rows
      const img = ctx.getImageData(0, 0, 128, 12)
      ctx.putImageData(img, 0, 20)
      ctx.fillStyle = '#8a6a48'
      ctx.fillRect(0, 0, 128, 12)
      speckle(ctx, r, 128, 12, ['#95744f', '#7d5f40'], 150)
      return c
    }
  }
}

export function texture(kind: Kind): THREE.Texture {
  const t = new THREE.CanvasTexture(draw(kind))
  t.wrapS = THREE.RepeatWrapping
  t.wrapT = kind === 'fill' || kind === 'body' ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping
  t.magFilter = THREE.NearestFilter
  t.minFilter = THREE.NearestFilter
  t.colorSpace = THREE.SRGBColorSpace
  return t
}
