import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { mkdir, readdir, readFile, stat, unlink, writeFile } from 'node:fs/promises'
import { PDFParse } from 'pdf-parse'

/**
 * File Assistant — upload a PDF or TXT, JARVIS reads it and summarises.
 *
 * The /upload HTTP endpoint in server.mjs saves the raw bytes here; this
 * module owns extracting readable text from them and exposes that as one MCP
 * tool, `summarize_file`. It deliberately returns the extracted TEXT rather
 * than a pre-written summary — every other read tool in this bridge (search,
 * the camera, sysinfo) hands the model raw material and lets it compose the
 * actual sentence, and a file is no different. Pre-summarising here would
 * also mean writing a second, worse answer that the model's own reply then
 * has to repeat.
 */

const DIR = join(homedir(), '.jarvis-uploads')
const MAX_BYTES = 10 * 1024 * 1024 // 10 MB
const ALLOWED_EXT = new Set(['.pdf', '.txt'])
/** Plenty for a demo session; old uploads are pruned rather than kept forever. */
const MAX_FILES = 20
/** Comfortably inside a voice answer's budget — see MAX_UNSPOKEN in tts.ts
 *  for why a model given more than this tends to try to read all of it. */
const MAX_EXTRACTED_CHARS = 12_000

const newId = () => `f${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`

async function ensureDir() {
  await mkdir(DIR, { recursive: true })
}

/** Sanitised to a safe basename — this is user-chosen text landing in a file
 *  name, not a path to trust. */
function safeName(filename) {
  const base = String(filename ?? 'upload').split(/[/\\]/).pop() ?? 'upload'
  return base.replace(/[^\w.\- ]/g, '_').slice(-120) || 'upload'
}

async function prune() {
  try {
    const entries = await readdir(DIR)
    if (entries.length <= MAX_FILES) return
    const withTimes = await Promise.all(
      entries.map(async (name) => {
        const s = await stat(join(DIR, name)).catch(() => null)
        return { name, mtime: s?.mtimeMs ?? 0 }
      }),
    )
    withTimes.sort((a, b) => a.mtime - b.mtime)
    const extra = withTimes.slice(0, withTimes.length - MAX_FILES)
    await Promise.all(extra.map((e) => unlink(join(DIR, e.name)).catch(() => {})))
  } catch {
    /* pruning is tidiness, not correctness — a failure here must not break an upload */
  }
}

/**
 * Validate and save an uploaded file. Thrown errors carry a plain-English
 * `.message` the HTTP handler returns as-is — this is the one place that
 * decides what's acceptable, so the message is written for the end user.
 */
export async function saveUpload(filename, buffer) {
  const name = safeName(filename)
  const dot = name.lastIndexOf('.')
  const ext = dot === -1 ? '' : name.slice(dot).toLowerCase()
  if (!ALLOWED_EXT.has(ext)) {
    throw new Error('Only .pdf and .txt files are supported.')
  }
  if (buffer.length === 0) {
    throw new Error('The file is empty.')
  }
  if (buffer.length > MAX_BYTES) {
    throw new Error(`The file is too large — the limit is ${MAX_BYTES / 1024 / 1024} MB.`)
  }

  await ensureDir()
  const id = newId()
  const stored = `${id}__${name}`
  await writeFile(join(DIR, stored), buffer)
  await prune()
  return { id, filename: name, stored, bytes: buffer.length }
}

async function findStoredFile(id) {
  await ensureDir()
  const entries = await readdir(DIR)
  return entries.find((e) => e.startsWith(`${id}__`)) ?? null
}

/** The most recently saved upload, for when the user says "the file I
 *  uploaded" in a conversation that never saw its id — after a page reload or
 *  "New conversation", the file is still on disk but the id is not in memory. */
async function latestStoredFile() {
  await ensureDir()
  const entries = await readdir(DIR)
  let latest = null
  for (const name of entries) {
    const s = await stat(join(DIR, name)).catch(() => null)
    if (s && (!latest || s.mtimeMs > latest.mtime)) latest = { name, mtime: s.mtimeMs }
  }
  return latest?.name ?? null
}

/** Extract readable text from a saved upload. Returns `{ filename, text }`
 *  or throws a plain-English error — never silently returns nothing. */
export async function extractText(id) {
  const stored = id ? await findStoredFile(id) : await latestStoredFile()
  if (!stored) {
    throw new Error(id ? 'No uploaded file matches that id.' : 'Nothing has been uploaded yet.')
  }
  const path = join(DIR, stored)
  const filename = stored.slice(stored.indexOf('__') + 2)
  const ext = filename.slice(filename.lastIndexOf('.')).toLowerCase()

  if (ext === '.txt') {
    const text = await readFile(path, 'utf8')
    return { filename, text }
  }

  // .pdf — the only other extension saveUpload accepts.
  const buffer = await readFile(path)
  const parser = new PDFParse({ data: buffer })
  try {
    const result = await parser.getText()
    return { filename, text: result.text ?? '' }
  } catch (err) {
    throw new Error(`Could not read that PDF: ${err?.message ?? err}`)
  } finally {
    await parser.destroy()
  }
}

const ok = (text) => ({ content: [{ type: 'text', text }] })
const refuse = (text) => ({ isError: true, content: [{ type: 'text', text }] })

export function fileServer() {
  return createSdkMcpServer({
    name: 'jarvis_files',
    version: '1.0.0',
    instructions:
      'Read back the text of a file the user just uploaded through the HUD, ' +
      'so you can summarise or answer questions about it. Call this right ' +
      "after the user says they've uploaded something, and whenever they " +
      'ask about "the file" or "the document" — even with no id in this ' +
      'conversation, since uploads outlive it. Never say there is no upload ' +
      'without calling this first.',
    tools: [
      tool(
        'summarize_file',
        'Extract the text of an uploaded PDF or TXT file so you can summarise ' +
          'it or answer questions about it. Pass the id the upload returned ' +
          'if you have it; leave it out to read the most recent upload.',
        {
          id: z
            .string()
            .optional()
            .describe('The id returned when the file was uploaded. Omit for the latest upload.'),
        },
        async (args) => {
          const id = String(args.id ?? '').trim()
          try {
            const { filename, text } = await extractText(id)
            const trimmed = text.trim()
            if (!trimmed) {
              return ok(
                `"${filename}" contains no extractable text (it may be a scanned ` +
                  'image PDF with no text layer). Say so rather than guessing ' +
                  'at its contents.',
              )
            }
            const truncated = trimmed.length > MAX_EXTRACTED_CHARS
            const body = trimmed.slice(0, MAX_EXTRACTED_CHARS)
            return ok(
              `Text extracted from "${filename}"${truncated ? ' (truncated)' : ''}:\n\n${body}`,
            )
          } catch (err) {
            return refuse(err?.message ?? String(err))
          }
        },
      ),
    ],
  })
}
