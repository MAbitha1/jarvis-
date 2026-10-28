import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { readFile, writeFile } from 'node:fs/promises'

/**
 * The task list — JARVIS's one piece of durable state.
 *
 * Everything else in this bridge is either read-only (search, the camera) or
 * ephemeral (panels, the UI controls) — it lives and dies with the socket.
 * Tasks are the one thing that is supposed to still be there tomorrow, so they
 * get the simplest persistence that is actually durable: one JSON file on
 * disk, read-modify-written on every change. A real database would be the
 * right call at a scale this app will never reach; a file both voice commands
 * and the HUD's Tasks panel can agree on is the right call at this one.
 *
 * Exported as plain functions (not only as MCP tools) so the bridge's HTTP
 * /tasks endpoints — what the HUD panel talks to — and the voice tools below
 * share one implementation and therefore one file format. Voice and the panel
 * are two doors onto the same list, never two lists.
 */

const FILE = join(homedir(), '.jarvis-tasks.json')

const newId = () => `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`

export async function loadTasks() {
  try {
    const raw = await readFile(FILE, 'utf8')
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    // No file yet, or it's corrupt — either way, an empty list is the safe
    // read. Never throws: a missing task file must not take the turn down.
    return []
  }
}

async function saveTasks(tasks) {
  await writeFile(FILE, JSON.stringify(tasks, null, 2), 'utf8')
}

export async function addTask(text) {
  const tasks = await loadTasks()
  const task = {
    id: newId(),
    text: String(text).trim(),
    done: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
  tasks.push(task)
  await saveTasks(tasks)
  return task
}

export async function setTaskDone(id, done) {
  const tasks = await loadTasks()
  const task = tasks.find((t) => t.id === id)
  if (!task) return null
  task.done = done
  task.updatedAt = Date.now()
  await saveTasks(tasks)
  return task
}

export async function editTaskText(id, text) {
  const tasks = await loadTasks()
  const task = tasks.find((t) => t.id === id)
  if (!task) return null
  task.text = String(text).trim()
  task.updatedAt = Date.now()
  await saveTasks(tasks)
  return task
}

export async function deleteTask(id) {
  const tasks = await loadTasks()
  const next = tasks.filter((t) => t.id !== id)
  if (next.length === tasks.length) return false
  await saveTasks(next)
  return true
}

const ok = (text) => ({ content: [{ type: 'text', text }] })
const refuse = (text) => ({ isError: true, content: [{ type: 'text', text }] })

/** Find a task by id, or by a case-insensitive substring of its text — voice
 *  commands rarely carry the id, they carry what the task was about. */
async function findTask(idOrText) {
  const tasks = await loadTasks()
  const needle = String(idOrText ?? '').trim()
  if (!needle) return { tasks, task: null }
  const byId = tasks.find((t) => t.id === needle)
  if (byId) return { tasks, task: byId }
  const lower = needle.toLowerCase()
  const byText = tasks.find((t) => t.text.toLowerCase().includes(lower))
  return { tasks, task: byText ?? null }
}

function describe(tasks) {
  if (!tasks.length) return 'There are no tasks.'
  return tasks
    .map((t, i) => `${i + 1}. [${t.done ? 'x' : ' '}] ${t.text}`)
    .join('\n')
}

export function taskServer() {
  return createSdkMcpServer({
    name: 'jarvis_tasks',
    version: '1.0.0',
    instructions:
      'A simple persistent task list — add, list, complete, edit and delete ' +
      "items. It's the user's own to-do list, not a project tracker; keep " +
      'entries short.',
    tools: [
      tool(
        'task_add',
        'Add a new task to the list, e.g. "buy milk" or "call the dentist".',
        { text: z.string().min(1).describe('The task, in a few words.') },
        async (args) => {
          const text = String(args.text ?? '').trim()
          if (!text) return refuse('No task text was given.')
          await addTask(text)
          return ok(`Added: "${text}".`)
        },
      ),

      tool('task_list', 'List every task, done and not done.', {}, async () => {
        const tasks = await loadTasks()
        return ok(describe(tasks))
      }),

      tool(
        'task_complete',
        'Mark a task done (or not done again). Identify it by id or by a ' +
          'few words from its text.',
        {
          task: z.string().min(1).describe('The task\'s id, or a word or two from its text.'),
          done: z.boolean().default(true).catch(true).describe('false to un-complete it.'),
        },
        async (args) => {
          const { task } = await findTask(args.task)
          if (!task) return refuse(`No task matching "${args.task}" was found.`)
          const done = args.done !== false
          await setTaskDone(task.id, done)
          return ok(`${done ? 'Completed' : 'Reopened'}: "${task.text}".`)
        },
      ),

      tool(
        'task_edit',
        'Change the wording of an existing task.',
        {
          task: z.string().min(1).describe('The task\'s id, or a word or two from its text.'),
          text: z.string().min(1).describe('The new text.'),
        },
        async (args) => {
          const { task } = await findTask(args.task)
          if (!task) return refuse(`No task matching "${args.task}" was found.`)
          const text = String(args.text ?? '').trim()
          if (!text) return refuse('No replacement text was given.')
          await editTaskText(task.id, text)
          return ok(`Updated: "${task.text}" -> "${text}".`)
        },
      ),

      tool(
        'task_delete',
        'Remove a task entirely.',
        { task: z.string().min(1).describe('The task\'s id, or a word or two from its text.') },
        async (args) => {
          const { task } = await findTask(args.task)
          if (!task) return refuse(`No task matching "${args.task}" was found.`)
          await deleteTask(task.id)
          return ok(`Deleted: "${task.text}".`)
        },
      ),
    ],
  })
}
