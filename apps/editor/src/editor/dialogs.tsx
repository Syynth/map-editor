/**
 * The New Map dialog, open while the view's dialog is `new-map`: from the
 * project menu, or the shell's File › New Map. An empty map, listed after the
 * others and opened.
 */

import { useState } from 'react'

import { useHost, useViewSelector } from '@papercut/editor-host'
import { Action, Dialog, Field, TextInput } from '@papercut/ui'

import { run } from './commands'
import { newMapIn, type Session } from './session'

export function NewMapDialog({ session }: { session: Session }) {
  const host = useHost()
  const opened = useViewSelector((snapshot) => snapshot.context.dialog) === 'new-map'
  const [name, setName] = useState('')
  const close = (): void => {
    setName('')
    run(host, 'view.set', { dialog: null })
  }
  const create = (): void => {
    const mapName = name.trim()
    if (!mapName) return
    close()
    newMapIn(host, session, mapName)
      .then(() => run(host, 'view.set', { notice: `New map ${mapName}` }))
      .catch((error: unknown) => run(host, 'view.set', { notice: error instanceof Error ? error.message : String(error) }))
  }
  return (
    <Dialog
      opened={opened}
      onClose={close}
      title="New map"
      description="An empty 32 × 32 map, listed after the others and opened."
      footer={
        <>
          <Action title="Cancel" onClick={close} />
          <Action title="Create map" tone="accent" disabled={!name.trim()} onClick={create} />
        </>
      }
    >
      <Field label="Name">
        <TextInput value={name} onChange={setName} placeholder="Harbour Road" />
      </Field>
    </Dialog>
  )
}
