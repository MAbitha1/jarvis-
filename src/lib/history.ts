import type { Turn } from '../store'

/**
 * Chat history — persisted entirely in the browser.
 *
 * The bridge's own session (the agent's memory) lives on the WebSocket and is
 * explicitly NOT persisted anywhere — see bridge.ts's `resetSession`. What this
 * module keeps is the on-screen record of past conversations, so a reload
 * doesn't wipe the transcript and old ones aren't simply gone. Opening an old
 * conversation restores what was SAID; it does not and cannot restore what the
 * model remembers, since that was never ours to save.
 */

export type ConversationRecord = {
  id: string
  startedAt: number
  updatedAt: number
  turns: Turn[]
}

const KEY = 'jarvis.history'
const CURRENT_KEY = 'jarvis.history.current'
/** Plenty for a demo machine's localStorage without needing a cap on size. */
const MAX_CONVERSATIONS = 25

const newId = () =>
  globalThis.crypto?.randomUUID?.() ??
  `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`

function readAll(): ConversationRecord[] {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function writeAll(list: ConversationRecord[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(list.slice(-MAX_CONVERSATIONS)))
  } catch {
    /* storage full or unavailable — history just stops persisting, nothing crashes */
  }
}

export function loadAll(): ConversationRecord[] {
  return readAll().sort((a, b) => b.updatedAt - a.updatedAt)
}

export function getCurrentId(): string {
  try {
    const existing = localStorage.getItem(CURRENT_KEY)
    if (existing) return existing
  } catch {
    /* fall through to a fresh, session-only id */
  }
  const id = newId()
  try {
    localStorage.setItem(CURRENT_KEY, id)
  } catch {
    /* unavailable — the id still works for this page's lifetime */
  }
  return id
}

/** Restore the turns for the conversation currently marked "current" —
 *  called once at boot so a reload doesn't lose the transcript. */
export function loadCurrentTurns(): Turn[] {
  const id = getCurrentId()
  return readAll().find((c) => c.id === id)?.turns ?? []
}

/** Upsert the live turn list into the current conversation's record. Cheap
 *  enough to call on every change; the caller debounces regardless. */
export function saveCurrentTurns(turns: Turn[]): void {
  if (!turns.length) return
  const id = getCurrentId()
  const all = readAll()
  const now = Date.now()
  const i = all.findIndex((c) => c.id === id)
  if (i >= 0) {
    all[i] = { ...all[i], turns, updatedAt: now }
  } else {
    all.push({ id, startedAt: now, updatedAt: now, turns })
  }
  writeAll(all)
}

/** Mint a fresh conversation and make it current. Returns its id. */
export function newConversation(): string {
  const id = newId()
  try {
    localStorage.setItem(CURRENT_KEY, id)
  } catch {
    /* session-only */
  }
  return id
}

/** Make an existing conversation the current one — opening it from the
 *  history list continues it rather than only previewing it: whatever is
 *  said next is appended to this record, not the one it replaced. */
export function setCurrentId(id: string): void {
  try {
    localStorage.setItem(CURRENT_KEY, id)
  } catch {
    /* session-only */
  }
}

/** Replace the on-screen transcript with a saved one, without touching which
 *  conversation is "current" for new messages — see the module note above
 *  about why the model's own memory can't come along for the ride. */
export function turnsFor(id: string): Turn[] {
  return readAll().find((c) => c.id === id)?.turns ?? []
}

export function deleteConversation(id: string): void {
  writeAll(readAll().filter((c) => c.id !== id))
  try {
    if (localStorage.getItem(CURRENT_KEY) === id) localStorage.removeItem(CURRENT_KEY)
  } catch {
    /* unavailable — harmless */
  }
}
