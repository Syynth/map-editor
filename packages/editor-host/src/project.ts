/**
 * The project actor: what every map in the folder shares, held live.
 *
 * The project document (`@papercut/document`'s `ProjectDoc`) is small — the
 * material library, the resolution profile, the sheet list, the map list —
 * so unlike the map it is context, replaced whole on every edit. Edits are
 * commands, one per list, each taking the list whole: a material reorder is
 * a priority change and lands as one edit; ids never move, so no voxel
 * changes what it is made of. Nothing here is undoable: these are settings,
 * as brink's are, not strokes.
 *
 * Where the project came from — a folder on disk, the sample in memory —
 * is not this actor's concern. `replace` is how a whole project arrives
 * once one is opened; the host sends it, never a command from outside.
 */

import type { ProjectDoc } from '@papercut/document'
import { commands, reserveOwner } from '@papercut/registry'
import { setup, types } from 'xstate'
import { z } from 'zod'

export const PROJECT_OWNER = reserveOwner('editor-host.project')

const relativePath = z.string().min(1).refine((p) => !p.startsWith('/') && !p.includes('\\') && !p.split('/').includes('..'), { message: 'a path inside the project' })

/** A terrain reference: the sheet's file name and the terrain's id in its sidecar. */
const terrainRef = z.object({ sheet: z.string().min(1), terrain: z.string().min(1) }).strict()
const materialDef = z
  .object({
    id: z.int().min(0),
    name: z.string().min(1),
    color: z.int().min(0).max(0xffffff),
    role: z.enum(['top', 'wall', 'any']),
    top: terrainRef,
    side: terrainRef.exactOptional(),
  })
  .strict()
/** The whole list, replaced: its order is the materials' priority, so a reorder is as much an edit as a rename. */
const materialsSet = z
  .object({ materials: z.array(materialDef).min(1) })
  .strict()
  .refine(({ materials }) => new Set(materials.map((m) => m.id)).size === materials.length, { message: 'material ids must be unique' })

const sheetEntry = z.object({ path: relativePath, tile: z.int().min(1), terrainSet: relativePath.nullable() }).strict()
const sheetsSet = z
  .object({ sheets: z.array(sheetEntry) })
  .strict()
  .refine(({ sheets }) => new Set(sheets.map((s) => s.path.slice(s.path.lastIndexOf('/') + 1))).size === sheets.length, { message: 'a sheet is named by its file name, so two cannot share one' })

const mapsSet = z.object({ maps: z.array(relativePath) }).strict()

const projectSettings = z
  .object({
    name: z.string().min(1).exactOptional(),
    resolution: z.object({ texelDensity: z.int().min(1), filtering: z.enum(['nearest', 'linear']) }).strict().exactOptional(),
  })
  .strict()

export type ProjectSettings = z.infer<typeof projectSettings>
export type MaterialsSetArgs = z.infer<typeof materialsSet>
export type SheetsSetArgs = z.infer<typeof sheetsSet>
export type MapsSetArgs = z.infer<typeof mapsSet>

commands.declare(PROJECT_OWNER, { id: 'project.set', title: 'Set Project Settings', category: 'Project', args: projectSettings })
commands.declare(PROJECT_OWNER, { id: 'project.materials.set', title: 'Set Materials', category: 'Project', args: materialsSet })
commands.declare(PROJECT_OWNER, { id: 'project.sheets.set', title: 'Set Sheets', category: 'Project', args: sheetsSet })
commands.declare(PROJECT_OWNER, { id: 'project.maps.set', title: 'Set Map List', category: 'Project', args: mapsSet })

export interface ProjectContext {
  readonly project: ProjectDoc
}

/** The project logic, seeded with the project the app opened. A closure, not `input`: `input` leaks into the inspector. */
export function projectLogicWith(initial: ProjectDoc) {
  return setup({
    schemas: {
      context: types<ProjectContext>(),
      events: {
        command: types<{ id: string; args: unknown }>(),
        /** A whole project arriving: opened from a folder, or created. */
        replace: types<{ project: ProjectDoc }>(),
      },
    },
  }).createMachine({
    id: 'project',
    context: { project: initial },
    initial: 'ready',
    states: {
      ready: {
        on: {
          command: ({ context, event }) => {
            const { project } = context
            switch (event.id) {
              case 'project.set': {
                const { name, resolution } = event.args as ProjectSettings
                return { context: { project: { ...project, ...(name === undefined ? {} : { name }), ...(resolution === undefined ? {} : { resolution: resolution }) } } }
              }
              case 'project.materials.set':
                return { context: { project: { ...project, materials: (event.args as MaterialsSetArgs).materials.map((m) => ({ ...m })) } } }
              case 'project.sheets.set':
                return { context: { project: { ...project, sheets: (event.args as SheetsSetArgs).sheets.map((s) => ({ ...s })) } } }
              case 'project.maps.set':
                return { context: { project: { ...project, maps: [...(event.args as MapsSetArgs).maps] } } }
              default:
                return undefined
            }
          },
          replace: ({ event }) => ({ context: { project: event.project } }),
        },
      },
    },
  })
}

export type ProjectLogic = ReturnType<typeof projectLogicWith>
