/** One applied edit: whether it is still the newest, and how to take it back. */
export type AppliedEdit = { isNewest: () => boolean; undo: () => void }

/** Commands on a session with its own history: all are checked before any is applied. */
export function applyToSession<D, C>(
  session: { command: (command: C) => void; undo: () => void; snapshot: () => { document: D } },
  reduce: (document: D, command: C) => D,
  commands: C[]
): AppliedEdit {
  commands.reduce(reduce, session.snapshot().document)
  const content = () => JSON.stringify(session.snapshot().document)
  // A command that changes nothing records no history step, so Undo must not count it.
  let steps = 0
  let after = content()
  for (const command of commands) {
    session.command(command)
    const next = content()
    if (next !== after) steps += 1
    after = next
  }
  return {
    // By content: autosave replaces the object without changing the work.
    isNewest: () => steps > 0 && content() === after,
    undo: () => {
      for (let step = 0; step < steps; step += 1) session.undo()
    },
  }
}
