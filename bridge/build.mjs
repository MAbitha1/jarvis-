import { createSdkMcpServer, query, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { execFile, spawn } from 'node:child_process'
import { homedir, tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mkdir, mkdtemp, readdir, rm, stat } from 'node:fs/promises'

/**
 * "Build me a website for my Diwali sweets" — JARVIS hands the job to a second
 * Claude agent, a coder, working in a fresh folder under ~/JARVIS Projects.
 *
 * It runs in the background. A real build takes minutes, and a spoken turn
 * cannot hold the conversation that long (the page gives up on a turn after
 * two quiet minutes, see IDLE_TIMEOUT_MS in bridge.ts), so build_project
 * answers at once and project_status reports on it. When the build finishes
 * the site opens in the default browser, which is the user's signal it's done.
 *
 * The coder gets file tools only — no shell, no web — and every path it
 * touches must sit inside its own project folder. It can write a website;
 * it cannot touch anything else on the machine.
 */

export const PROJECTS_DIR = join(homedir(), 'JARVIS Projects')

const BUILDER_TOOLS = ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'TodoWrite']
const PATH_KEYS = ['file_path', 'path', 'notebook_path']
const CHECK_TOOL = 'mcp__site_check__check_page'

/** id -> { id, name, brief, dir, state, startedAt, finishedAt, summary, error, files } */
const builds = new Map()

const slug = (s) =>
  String(s ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'project'

async function freshDir(name) {
  await mkdir(PROJECTS_DIR, { recursive: true })
  const base = join(PROJECTS_DIR, slug(name))
  for (let i = 1; ; i++) {
    const dir = i === 1 ? base : `${base}-${i}`
    if (!(await stat(dir).catch(() => null))) {
      await mkdir(dir, { recursive: true })
      return dir
    }
  }
}

export function inside(dir, p) {
  if (typeof p !== 'string' || !p) return true // the tool's default is its cwd
  const rel = relative(dir, isAbsolute(p) ? p : resolve(dir, p))
  return !rel.startsWith('..') && !isAbsolute(rel)
}

/**
 * Load the page in headless Chrome and collect what its console reports.
 *
 * The coder cannot run what it writes, so before this existed it shipped a
 * Diwali shop whose script called a function before the variable it used was
 * assigned — one TypeError, and every section stayed hidden behind its
 * scroll-reveal class: a blank page, reported as done. A throwaway profile
 * keeps this apart from the user's own running Chrome.
 */
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'

export async function checkPage(dir, file = 'index.html') {
  const page = join(dir, file)
  if (!inside(dir, page) || !(await stat(page).catch(() => null))) {
    return { ok: false, problems: [`${file} does not exist yet.`] }
  }
  if (!(await stat(CHROME).catch(() => null))) {
    return { ok: true, problems: [], skipped: 'Chrome is not installed, so the page could not be checked.' }
  }
  const profile = await mkdtemp(join(tmpdir(), 'jarvis-check-'))
  try {
    const stderr = await new Promise((done) => {
      execFile(
        CHROME,
        [
          '--headless=new', '--disable-gpu', '--no-first-run', `--user-data-dir=${profile}`,
          '--enable-logging=stderr', '--v=0', '--virtual-time-budget=4000', '--dump-dom',
          pathToFileURL(page).href,
        ],
        { timeout: 40_000, maxBuffer: 20e6, windowsHide: true },
        (_err, _stdout, err) => done(String(err ?? '')),
      )
    })
    const problems = stderr
      .split('\n')
      .filter((l) => /:CONSOLE/.test(l) && /Uncaught|Error|Failed|is not defined|Cannot read/i.test(l))
      .map((l) => l.replace(/^.*?:CONSOLE[^\]]*\]\s*/, '').trim())
    return { ok: problems.length === 0, problems: [...new Set(problems)].slice(0, 10) }
  } finally {
    await rm(profile, { recursive: true, force: true }).catch(() => {})
  }
}

/** The coder's own test tool, scoped to its one project folder. */
function checkServer(dir) {
  return createSdkMcpServer({
    name: 'site_check',
    version: '1.0.0',
    tools: [
      tool(
        'check_page',
        'Open a page of this project in a real browser (headless Chrome) and ' +
          'return every JavaScript error and failed load from its console.',
        { file: z.string().optional().describe('The HTML file, default index.html.') },
        async (args) => {
          const r = await checkPage(dir, args.file || 'index.html')
          const text = r.skipped ?? (r.ok ? 'No errors: the page loads cleanly.' : `Errors:\n${r.problems.join('\n')}`)
          return { content: [{ type: 'text', text }] }
        },
      ),
    ],
  })
}

const BUILDER_PROMPT = (brief) => `Build this project in the current folder:

${brief}

Unless the request says otherwise, make it a polished, complete static website:
index.html plus separate CSS and JavaScript files, opened straight from disk
with no build step and no npm. Fonts from Google Fonts and libraries from a
CDN are fine. Use realistic sample content rather than lorem ipsum, a strong
visual design, and a layout that works on phones. Images: use CSS, inline SVG
or emoji rather than image files you cannot create.

All content must be visible even if JavaScript fails: never hide sections in
CSS and rely on a script to reveal them. In scripts, define every variable and
function before any code that runs at load time uses it.

When the files are written, call check_page. If it reports any error, fix it
and call check_page again, until it reports the page loads cleanly.

Work only in this folder. When it is finished, reply with one short sentence
describing what you built.`

const FIX_PROMPT = (problems) => `The finished page still reports these errors in the browser:

${problems.join('\n')}

Fix them, then call check_page until it reports the page loads cleanly. Reply
with one short sentence when done.`

async function listFiles(dir) {
  const out = []
  const walk = async (d) => {
    for (const e of await readdir(d, { withFileTypes: true }).catch(() => [])) {
      const full = join(d, e.name)
      if (e.isDirectory()) await walk(full)
      else out.push(relative(dir, full))
    }
  }
  await walk(dir)
  return out
}

/** Open the finished site — or the folder, if it built no index.html. */
async function openResult(build) {
  const index = join(build.dir, 'index.html')
  const target = (await stat(index).catch(() => null)) ? index : build.dir
  spawn('explorer.exe', [target], { detached: true, stdio: 'ignore' }).unref()
}

export async function startBuild({ name, brief, model }) {
  const dir = await freshDir(name || brief)
  const id = `b${Date.now().toString(36)}`
  const build = { id, name: name || brief.slice(0, 40), brief, dir, state: 'building', startedAt: Date.now() }
  builds.set(id, build)

  /** One run of the coder; `resume` continues its earlier session, so a fix
   *  round keeps everything it already knows about the code it wrote. */
  const runCoder = async (prompt, resume) => {
    let sessionId = resume
    const session = query({
      prompt,
      options: {
        cwd: dir,
        model,
        effort: 'medium',
        maxTurns: 60,
        tools: BUILDER_TOOLS,
        mcpServers: { site_check: checkServer(dir) },
        settingSources: [],
        permissionMode: 'default',
        ...(resume ? { resume } : {}),
        canUseTool: async (toolName, input) => {
          const ok =
            toolName === CHECK_TOOL ||
            (BUILDER_TOOLS.includes(toolName) && PATH_KEYS.every((k) => inside(dir, input?.[k])))
          return ok
            ? { behavior: 'allow', updatedInput: input }
            : { behavior: 'deny', message: `Only files inside ${dir} may be used.` }
        },
      },
    })
    for await (const msg of session) {
      if (msg.session_id) sessionId = msg.session_id
      if (msg.type === 'result') {
        if (msg.subtype === 'success' && !msg.is_error) {
          build.summary = String(msg.result ?? '').trim()
          build.error = undefined
        } else {
          build.error = String(msg.result ?? msg.subtype)
        }
      }
    }
    return sessionId
  }

  void (async () => {
    try {
      let sessionId = await runCoder(BUILDER_PROMPT(brief))
      // Trust, but check: the coder is told to test its page, and this is the
      // net under that. Two fix rounds, then report whatever is left.
      for (let round = 0; round < 2 && !build.error; round++) {
        const check = await checkPage(dir)
        build.problems = check.problems
        if (check.ok) break
        sessionId = await runCoder(FIX_PROMPT(check.problems), sessionId)
      }
      if (!build.error && build.problems?.length) build.problems = (await checkPage(dir)).problems
      build.files = await listFiles(dir)
      if (!build.error && !build.files.length) build.error = 'The builder finished without writing any files.'
      build.state = build.error ? 'failed' : 'done'
      if (!build.error) await openResult(build)
    } catch (err) {
      build.state = 'failed'
      build.error = String(err?.message ?? err)
    } finally {
      build.finishedAt = Date.now()
      console.log(`[jarvis] build ${build.id} ${build.state}: ${build.dir}${build.error ? ` — ${build.error}` : ''}`)
    }
  })()

  return build
}

function describe(b) {
  const mins = Math.max(1, Math.round(((b.finishedAt ?? Date.now()) - b.startedAt) / 60000))
  if (b.state === 'building') return `"${b.name}" is still being built (${mins} min so far) in ${b.dir}.`
  if (b.state === 'failed') return `"${b.name}" failed after ${mins} min: ${b.error}`
  return (
    `"${b.name}" is finished (${mins} min) in ${b.dir} and has been opened in the browser. ` +
    `Files: ${b.files.join(', ')}. Builder's summary: ${b.summary}` +
    (b.problems?.length
      ? ` It still shows these errors in the browser: ${b.problems.join('; ')}`
      : ' It loads in the browser without errors.')
  )
}

const ok = (text) => ({ content: [{ type: 'text', text }] })
const refuse = (text) => ({ isError: true, content: [{ type: 'text', text }] })

/**
 * Hand a request to the Claude desktop app, live on screen.
 *
 * claude://claude.ai/new?q= opens a new chat with the text already in the
 * message box — what the user asked for, "open Claude, new chat, type it".
 * It deliberately stops there: Claude shows its own "use caution before
 * running this prompt" notice on any prompt that arrives by link, so a
 * person must press send, and JARVIS does not press it for them.
 *
 * The link is opened through url.dll's protocol handler, never a shell, and
 * the text is URL-encoded, so nothing in it can be read as a command.
 */
const CLAUDE_WEBSITE_PROMPT = (brief) =>
  `Build this as a single, complete HTML file artifact so I can see it right away: ${brief}

Make it polished and modern: a strong visual design, realistic sample content
(no lorem ipsum), smooth but light animations, and a layout that works on
phones. Keep all content visible even if JavaScript fails.`

/** Opens the chat, clears any old draft, fills in `text` and brings Claude to
 *  the front — see scripts/claude-new-chat.ps1 for why each step is there.
 *  The text travels URL-encoded, so it is plain letters and %-escapes. */
export function openClaudeChat(text) {
  const url = `claude://claude.ai/new?q=${encodeURIComponent(text.slice(0, 4000))}`
  return new Promise((done) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', CLAUDE_CHAT_SCRIPT, '-Url', url],
      { timeout: 30_000, windowsHide: true },
      (err, stdout) => {
        try {
          done(JSON.parse(String(stdout).trim().split('\n').pop()))
        } catch {
          done({ ok: false, error: String(err?.message ?? 'Claude could not be opened.') })
        }
      },
    )
  })
}

const CLAUDE_CHAT_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'scripts', 'claude-new-chat.ps1')

/** Which editor to open a project in. The .exe itself, not the bin\*.cmd
 *  launcher: a .cmd needs cmd.exe, which mangles quoted paths with spaces —
 *  and both "Antigravity IDE" and "JARVIS Projects" have one. */
const EDITORS = {
  antigravity: join(homedir(), 'AppData', 'Local', 'Programs', 'Antigravity IDE', 'Antigravity.exe'),
  vscode: join(homedir(), 'AppData', 'Local', 'Programs', 'Microsoft VS Code', 'Code.exe'),
}

export function buildServer({ model }) {
  return createSdkMcpServer({
    name: 'jarvis_build',
    version: '1.0.0',
    instructions:
      'Build software projects for the user with a Claude coding agent: ' +
      'websites, landing pages, small web apps. build_project starts the work ' +
      'in the background and returns at once — say it has started and roughly ' +
      'how long it takes (a few minutes), then carry on. The finished site ' +
      'opens in their browser by itself. Use project_status when they ask how ' +
      'it is going. When they ask to do it IN the Claude app ("open Claude ' +
      'and make...", "Claude la panni thaa"), use build_in_claude_app instead.',
    tools: [
      tool(
        'build_in_claude_app',
        'Open the Claude desktop app on a new chat with the request already ' +
          'typed in, so the user watches Claude build it live. Use when they ' +
          'ask for it to happen in Claude. It is typed, not sent: tell them it ' +
          'is ready in Claude and to press Enter to run it — Claude asks a ' +
          'person to confirm any prompt that arrives this way.',
        {
          brief: z.string().min(1).describe('What to build, written out in full from what the user asked.'),
          website: z
            .boolean()
            .default(true)
            .describe('true to ask for a finished single-file website artifact; false to pass the brief as it is.'),
        },
        async (args) => {
          const r = await openClaudeChat(args.website ? CLAUDE_WEBSITE_PROMPT(args.brief) : args.brief)
          if (!r.ok) return refuse(r.error)
          return ok(
            'Claude is open on a new chat with the request typed in, waiting for them to press Enter.' +
              (r.inFront ? '' : ' Windows kept it behind another window, so tell them to click Claude in the taskbar.'),
          )
        },
      ),
      tool(
        'build_project',
        'Start building a project (by default a static website) from a ' +
          'description. Put everything the user asked for into the brief — ' +
          'subject, sections, style, colours, language. Returns immediately; ' +
          'the build takes about two to five minutes.',
        {
          name: z.string().min(1).describe('A short project name, e.g. "Diwali sweets shop".'),
          brief: z.string().min(1).describe('The full request, written out for the builder.'),
        },
        async (args) => {
          const running = [...builds.values()].find((b) => b.state === 'building')
          if (running) {
            return refuse(`"${running.name}" is still being built; wait for it to finish before starting another.`)
          }
          const b = await startBuild({ name: args.name, brief: args.brief, model })
          return ok(`Build started: "${b.name}" in ${b.dir}. It opens in the browser when done.`)
        },
      ),
      tool(
        'project_status',
        'How the current or most recent build is going, or a list of all builds this session.',
        { all: z.boolean().optional().describe('true to list every build this session.') },
        async (args) => {
          const list = [...builds.values()]
          if (!list.length) return ok(`No projects have been built this session. Projects live in ${PROJECTS_DIR}.`)
          return ok((args.all ? list : list.slice(-1)).map(describe).join('\n'))
        },
      ),
      tool(
        'open_project_in_editor',
        'Open the most recent project (or a named project folder under JARVIS ' +
          'Projects) in Antigravity or VS Code.',
        {
          editor: z.enum(['antigravity', 'vscode']).describe('Which editor.'),
          folder: z.string().optional().describe('A project folder name; omit for the latest build.'),
        },
        async (args) => {
          let dir = [...builds.values()].at(-1)?.dir
          if (args.folder) {
            const candidate = join(PROJECTS_DIR, slug(args.folder))
            if (!(await stat(candidate).catch(() => null))) {
              return refuse(`No project folder called "${args.folder}" in ${PROJECTS_DIR}.`)
            }
            dir = candidate
          }
          if (!dir) return refuse('No project has been built yet to open.')
          const launcher = EDITORS[args.editor]
          if (!(await stat(launcher).catch(() => null))) return refuse(`${args.editor} is not installed.`)
          spawn(launcher, [dir], { detached: true, stdio: 'ignore' }).unref()
          return ok(`Opened ${dir} in ${args.editor}.`)
        },
      ),
    ],
  })
}
