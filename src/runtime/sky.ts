/**
 * Sky and atmosphere.
 *
 * Offered in layers, cheapest first, per brief section 12. The prototype
 * implements the gradient sky and backdrop cards, which are the two that the
 * "no modeling" constraint actually depends on — an artist gets distant
 * mountains by painting a picture of mountains, not by building any.
 *
 * The sky drives fog and ambient colour, so picking a preset changes the whole
 * scene together rather than leaving the artist to match three colour pickers
 * by hand.
 */

import * as THREE from 'three'

import type { Atmosphere } from '@core/document'
import type { SpriteAsset } from './textures'
import { canvasTexture } from './billboard'

const SKY_VERTEX = /* glsl */ `
varying vec3 vWorldDirection;
void main() {
  vec4 worldPosition = modelMatrix * vec4(position, 1.0);
  vWorldDirection = normalize(worldPosition.xyz - cameraPosition);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`

const SKY_FRAGMENT = /* glsl */ `
uniform vec3 topColor;
uniform vec3 horizonColor;
uniform vec3 bottomColor;
uniform vec3 sunDirection;
uniform vec3 sunColor;
uniform float sunSize;
varying vec3 vWorldDirection;

void main() {
  vec3 dir = normalize(vWorldDirection);
  float h = dir.y;

  vec3 color;
  if (h >= 0.0) {
    color = mix(horizonColor, topColor, pow(clamp(h, 0.0, 1.0), 0.55));
  } else {
    color = mix(horizonColor, bottomColor, pow(clamp(-h, 0.0, 1.0), 0.5));
  }

  // A soft disc plus a wide glow, which reads as sun or moon depending on the
  // preset's colours without needing a separate sprite.
  float cosAngle = dot(dir, normalize(sunDirection));
  float disc = smoothstep(1.0 - sunSize, 1.0 - sunSize * 0.35, cosAngle);
  float glow = pow(max(cosAngle, 0.0), 48.0) * 0.35;
  color += sunColor * (disc + glow);

  gl_FragColor = vec4(color, 1.0);
  #include <colorspace_fragment>
}
`

const DEG = Math.PI / 180

export function sunDirection(atmosphere: Atmosphere): THREE.Vector3 {
  const azimuth = atmosphere.sunAzimuth * DEG
  const elevation = atmosphere.sunElevation * DEG
  return new THREE.Vector3(
    Math.sin(azimuth) * Math.cos(elevation),
    Math.sin(elevation),
    Math.cos(azimuth) * Math.cos(elevation),
  ).normalize()
}

export class Sky {
  readonly mesh: THREE.Mesh
  private material: THREE.ShaderMaterial
  private backdrops: THREE.Mesh[] = []
  readonly group = new THREE.Group()

  constructor() {
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        topColor: { value: new THREE.Color(0x4a8fd4) },
        horizonColor: { value: new THREE.Color(0xbcd7ee) },
        bottomColor: { value: new THREE.Color(0xe8e0cf) },
        sunDirection: { value: new THREE.Vector3(0, 1, 0) },
        sunColor: { value: new THREE.Color(0xfff3d6) },
        sunSize: { value: 0.02 },
      },
      vertexShader: SKY_VERTEX,
      fragmentShader: SKY_FRAGMENT,
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
    })
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(300, 32, 16), this.material)
    this.mesh.renderOrder = -1000
    this.group.add(this.mesh)
  }

  apply(atmosphere: Atmosphere, sprites: Record<string, SpriteAsset>, nearest: boolean): void {
    const uniforms = this.material.uniforms
    ;(uniforms.topColor.value as THREE.Color).setHex(atmosphere.skyTop)
    ;(uniforms.horizonColor.value as THREE.Color).setHex(atmosphere.skyHorizon)
    ;(uniforms.bottomColor.value as THREE.Color).setHex(atmosphere.skyBottom)
    ;(uniforms.sunColor.value as THREE.Color).setHex(atmosphere.sunColor)
    ;(uniforms.sunDirection.value as THREE.Vector3).copy(sunDirection(atmosphere))

    this.rebuildBackdrops(atmosphere, sprites, nearest)
  }

  private rebuildBackdrops(
    atmosphere: Atmosphere,
    sprites: Record<string, SpriteAsset>,
    nearest: boolean,
  ): void {
    for (const mesh of this.backdrops) {
      this.group.remove(mesh)
      mesh.geometry.dispose()
      ;(mesh.material as THREE.Material).dispose()
    }
    this.backdrops = []

    atmosphere.backdrop.forEach((card) => {
      const asset = sprites[card.sprite]
      if (!asset) return
      const texture = canvasTexture(asset.facings[0], nearest)
      texture.wrapS = THREE.RepeatWrapping
      const aspect = asset.widthTiles / asset.heightTiles
      const width = card.height * aspect

      // A cylinder section rather than a flat plane, so the card wraps around
      // the map instead of only working from one angle.
      const geometry = new THREE.CylinderGeometry(
        card.radius,
        card.radius,
        card.height,
        64,
        1,
        true,
      )
      const material = new THREE.MeshBasicMaterial({
        map: texture,
        transparent: true,
        opacity: card.opacity,
        side: THREE.BackSide,
        depthWrite: false,
        fog: false,
      })
      texture.repeat.set(Math.max(1, Math.round((card.radius * 2 * Math.PI) / width)), 1)

      const mesh = new THREE.Mesh(geometry, material)
      mesh.position.y = card.base + card.height / 2
      mesh.renderOrder = -900
      mesh.userData.parallax = card.parallax
      this.backdrops.push(mesh)
      this.group.add(mesh)
    })
  }

  /** Keep the dome on the camera and let backdrop cards lag it for parallax. */
  update(cameraPosition: THREE.Vector3, mapCentre: THREE.Vector3): void {
    this.mesh.position.copy(cameraPosition)
    for (const mesh of this.backdrops) {
      const parallax = mesh.userData.parallax as number
      mesh.position.x = mapCentre.x + (cameraPosition.x - mapCentre.x) * (1 - parallax)
      mesh.position.z = mapCentre.z + (cameraPosition.z - mapCentre.z) * (1 - parallax)
    }
  }

  dispose(): void {
    this.mesh.geometry.dispose()
    this.material.dispose()
    for (const mesh of this.backdrops) {
      mesh.geometry.dispose()
      ;(mesh.material as THREE.Material).dispose()
    }
  }
}
