import { useEffect, useState } from 'react'
import { BRIDGE_HTTP_URL } from '../config'
import { isTypingTarget } from '../lib/keys'

/**
 * The Tasks panel — the HUD's half of bridge/tasks.mjs's shared JSON file.
 *
 * Voice ("Jarvis, add a task...") and this panel are two doors onto the same
 * list, so every mutation here goes through the same /tasks HTTP endpoints
 * the voice tools write to, rather than keeping a second copy of the data.
 * Press T... no — T is already the audio self-test, so this one is K, for
 * "keep track".
 */

type Task = {
  id: string
  text: string
  done: boolean
  createdAt: number
  updatedAt: number
}

export function Tasks() {
  const [open, setOpen] = useState(false)
  const [tasks, setTasks] = useState<Task[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)

  const refresh = async () => {
    try {
      const res = await fetch(`${BRIDGE_HTTP_URL}/tasks`)
      if (!res.ok) throw new Error(`bridge returned ${res.status}`)
      setTasks(await res.json())
      setError(null)
    } catch (err) {
      setError(
        err instanceof Error
          ? `Couldn't reach the task list: ${err.message}`
          : 'Couldn\'t reach the task list.',
      )
    }
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target)) return
      if (e.key === 'k' && !e.repeat && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault()
        setOpen((o) => !o)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  useEffect(() => {
    if (open) void refresh()
  }, [open])

  if (!open) return null

  const add = async (e: React.FormEvent) => {
    e.preventDefault()
    const text = draft.trim()
    if (!text || busy) return
    setBusy(true)
    try {
      const res = await fetch(`${BRIDGE_HTTP_URL}/tasks`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text }),
      })
      if (!res.ok) throw new Error(`bridge returned ${res.status}`)
      setDraft('')
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not add the task.')
    } finally {
      setBusy(false)
    }
  }

  const toggle = async (task: Task) => {
    try {
      await fetch(`${BRIDGE_HTTP_URL}/tasks/${encodeURIComponent(task.id)}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ done: !task.done }),
      })
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not update the task.')
    }
  }

  const remove = async (task: Task) => {
    try {
      await fetch(`${BRIDGE_HTTP_URL}/tasks/${encodeURIComponent(task.id)}`, {
        method: 'DELETE',
      })
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not delete the task.')
    }
  }

  return (
    <div className="tasks" role="dialog" aria-label="Tasks">
      <div className="tasks-head">
        TASKS · <kbd>K</kbd> to close
      </div>

      <form className="tasks-add" onSubmit={add}>
        <input
          className="tasks-input"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Add a task…"
          autoComplete="off"
        />
        <button className="settings-btn" type="submit" disabled={!draft.trim() || busy}>
          Add
        </button>
      </form>

      {error && <div className="tasks-error">{error}</div>}

      {tasks === null && !error && <div className="settings-note">Loading…</div>}
      {tasks && tasks.length === 0 && (
        <div className="settings-note">Nothing on the list.</div>
      )}

      <div className="tasks-list">
        {tasks?.map((t) => (
          <div key={t.id} className={`tasks-row${t.done ? ' done' : ''}`}>
            <label className="tasks-check">
              <input type="checkbox" checked={t.done} onChange={() => void toggle(t)} />
              <span>{t.text}</span>
            </label>
            <button className="settings-hist-del" onClick={() => void remove(t)} title="Delete">
              ✕
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}
