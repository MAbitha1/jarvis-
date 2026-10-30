import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { homedir } from 'node:os'
import { join, dirname, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdir, readdir, stat } from 'node:fs/promises'
import si from 'systeminformation'

/**
 * Windows PC control — volume, brightness, Wi-Fi, and a handful of safe
 * one-shot actions (Notepad, Calculator, a screenshot, dark mode, locking
 * the session), all read through or acted on via fixed, reviewed PowerShell
 * scripts in ./scripts, never a string built from user or model text.
 *
 * Same shape as tasks.mjs: plain async functions do the real work (and are
 * what sysinfo.mjs calls to fold volume/brightness into the dashboard), and
 * pcServer() wraps them as MCP tools with zod-typed, validated parameters.
 * The bridge's existing JARVIS_ALLOW_WRITES gate (see decideTool in
 * server.mjs) decides which of these the model may actually call — nothing
 * here opens a second permission system. Every tool below that changes
 * machine state is named so decideTool's read-verb check denies it by
 * default: `set_*`, `mute_system`, `open_*`, `take_screenshot`, `wifi_set`,
 * `lock_pc`. Every tool that only reads is named to be allowed unconditionally:
 * `get_*`, `check_*`.
 */

const __dirname = dirname(fileURLToPath(import.meta.url))
const SCRIPTS = join(__dirname, 'scripts')
const execFileAsync = promisify(execFile)

/**
 * Every PowerShell call goes through here. `args` is always a fixed array of
 * already-validated values — never a template string — and `-File` takes a
 * path this module built, never one derived from the caller. PowerShell's
 * own argument parsing, not a shell, is what receives them.
 */
async function runPs(scriptName, args = []) {
  const scriptPath = join(SCRIPTS, scriptName)
  const { stdout } = await execFileAsync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, ...args],
    { timeout: 10_000, windowsHide: true },
  )
  const line = stdout.trim().split('\n').pop() ?? ''
  let parsed
  try {
    parsed = JSON.parse(line)
  } catch {
    throw new Error(`Unreadable response from ${scriptName}: ${stdout.slice(0, 200)}`)
  }
  if (!parsed.ok) throw new Error(parsed.error || `${scriptName} failed`)
  return parsed
}

/** Clamp and validate a percentage. Throws rather than silently clamping a
 *  wildly out-of-range value — "set volume to 400 percent" is almost always
 *  a misheard number, and a tool that quietly did something else entirely is
 *  worse than one that asks again. */
export function validatePercent(value) {
  const n = Math.round(Number(value))
  if (!Number.isFinite(n)) throw new Error(`"${value}" is not a number.`)
  if (n < 0 || n > 100) throw new Error(`${n} is out of range — percentages run 0 to 100.`)
  return n
}

/** A relative change ("increase by 10") applied to a known current value,
 *  clamped to stay in range rather than erroring — "turn it up" from 95
 *  should land on 100, not refuse. */
export function applyDelta(current, delta) {
  return Math.max(0, Math.min(100, Math.round(current + delta)))
}

// ---------------------------------------------------------------------------
// Volume
// ---------------------------------------------------------------------------

export async function getVolume() {
  const r = await runPs('volume.ps1', ['-Action', 'get'])
  return { percent: r.percent, muted: r.muted }
}

export async function setVolume(percent) {
  const n = validatePercent(percent)
  const r = await runPs('volume.ps1', ['-Action', 'set', '-Level', String(n)])
  return { percent: r.percent, muted: r.muted }
}

export async function adjustVolume(delta) {
  const current = await getVolume()
  return setVolume(applyDelta(current.percent, delta))
}

export async function muteSystem() {
  const r = await runPs('volume.ps1', ['-Action', 'mute'])
  return { percent: r.percent, muted: r.muted }
}

export async function unmuteSystem() {
  const r = await runPs('volume.ps1', ['-Action', 'unmute'])
  return { percent: r.percent, muted: r.muted }
}

// ---------------------------------------------------------------------------
// Brightness
// ---------------------------------------------------------------------------

export async function getBrightness() {
  try {
    const r = await runPs('brightness.ps1', ['-Action', 'get'])
    return { percent: r.percent }
  } catch (err) {
    return { unsupported: true, reason: String(err.message ?? err) }
  }
}

export async function setBrightness(percent) {
  const n = validatePercent(percent)
  try {
    const r = await runPs('brightness.ps1', ['-Action', 'set', '-Level', String(n)])
    return { percent: r.percent }
  } catch (err) {
    return { unsupported: true, reason: String(err.message ?? err) }
  }
}

export async function adjustBrightness(delta) {
  const current = await getBrightness()
  if (current.unsupported) return current
  return setBrightness(applyDelta(current.percent, delta))
}

// ---------------------------------------------------------------------------
// Wi-Fi / network
// ---------------------------------------------------------------------------

export async function checkWifiStatus() {
  const [ifaces, conns, radioOn] = await Promise.all([
    si.wifiInterfaces().catch(() => []),
    si.wifiConnections().catch(() => []),
    wifiRadioOn(),
  ])
  if (!Array.isArray(ifaces) || ifaces.length === 0) {
    return { hasWifiAdapter: false, connected: false }
  }
  const conn = Array.isArray(conns) ? conns[0] : null
  return {
    hasWifiAdapter: true,
    radioOn,
    adapter: ifaces[0].iface,
    connected: Boolean(conn?.ssid),
    ssid: conn?.ssid ?? null,
    signalQuality: typeof conn?.quality === 'number' ? conn.quality : null,
  }
}

export async function checkInternet() {
  try {
    const res = await fetch('https://www.gstatic.com/generate_204', {
      signal: AbortSignal.timeout(4000),
      cache: 'no-store',
    })
    return { online: res.ok || res.status === 204 }
  } catch {
    return { online: false }
  }
}

const WIFI_OFF_FALLBACK_MS = 30_000

/** Whether the Wi-Fi radio is switched on — the quick-settings toggle, which
 *  connection status alone can't tell apart from "on but not connected". */
export async function wifiRadioOn() {
  try {
    const r = await runPs('wifi-radio.ps1')
    return r.state === 'On'
  } catch {
    return null
  }
}

/**
 * Turn Wi-Fi on or off.
 *
 * Turning off requires `confirm: true` — see pcServer()'s tool description,
 * which tells the model to ask the user first and call back only once they
 * agree. Turning on never needs it.
 *
 * This switches the radio, as the quick-settings Wi-Fi button does, rather
 * than the adapter's admin state through netsh. The netsh route needs
 * Administrator rights, so from a normal bridge every single call failed with
 * "Access is denied"; and a disabled adapter drops out of wifiInterfaces(),
 * so even an elevated bridge could not have found it again to turn it back on.
 */
export async function wifiSet(on, confirm) {
  if (!on && !confirm) {
    throw new Error(
      'Turning Wi-Fi off needs confirmation — ask the user first, then call again with confirm: true.',
    )
  }
  try {
    const r = await runPs('wifi-radio.ps1', ['-State', on ? 'On' : 'Off'])
    return { ok: true, adapter: r.name, on: r.state === 'On' }
  } catch (err) {
    return { ok: false, error: String(err.message ?? err) }
  }
}

// ---------------------------------------------------------------------------
// One-shot actions
// ---------------------------------------------------------------------------

export function openNotepad() {
  spawn('notepad.exe', [], { detached: true, stdio: 'ignore', windowsHide: false }).unref()
  return { ok: true }
}

export function openCalculator() {
  spawn('calc.exe', [], { detached: true, stdio: 'ignore', windowsHide: false }).unref()
  return { ok: true }
}

/**
 * Open a folder in File Explorer, from however the user named it.
 *
 * Resolved in order: a well-known folder ("downloads", "photos"), a drive
 * ("D drive"), a full path, and otherwise a search by folder name under the
 * home folder and the other drives. Whatever is opened is a directory that
 * exists — the name is matched against the disk, never handed to a shell.
 */
const KNOWN_FOLDERS = {
  desktop: 'Desktop',
  document: 'Documents', documents: 'Documents', docs: 'Documents',
  download: 'Downloads', downloads: 'Downloads',
  picture: 'Pictures', pictures: 'Pictures', photo: 'Pictures', photos: 'Pictures',
  music: 'Music', song: 'Music', songs: 'Music',
  video: 'Videos', videos: 'Videos',
  home: '', user: '',
}

const SKIP_DIRS = new Set([
  'appdata', 'application data', 'local settings', 'node_modules', '.git',
  'windows', 'program files', 'program files (x86)', 'programdata',
  '$recycle.bin', 'system volume information', 'recovery',
])

async function isDir(p) {
  return (await stat(p).catch(() => null))?.isDirectory() ?? false
}

/** Breadth-first, so the shallowest match — usually the one meant — is found
 *  first, and bounded so a huge drive can't stall a spoken answer. */
async function findFolders(name, roots) {
  const want = name.toLowerCase()
  const exact = []
  const partial = []
  const queue = roots.map((r) => ({ dir: r, depth: 0 }))
  let visited = 0
  const deadline = Date.now() + 6000
  while (queue.length && visited < 20_000 && Date.now() < deadline && exact.length < 5) {
    const { dir, depth } = queue.shift()
    visited++
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const e of entries) {
      if (!e.isDirectory()) continue
      const lower = e.name.toLowerCase()
      if (SKIP_DIRS.has(lower) || lower.startsWith('.')) continue
      const full = join(dir, e.name)
      if (lower === want) exact.push(full)
      else if (lower.includes(want) && partial.length < 5) partial.push(full)
      if (depth < 4) queue.push({ dir: full, depth: depth + 1 })
    }
  }
  return exact.length ? exact : partial
}

async function driveRoots() {
  const roots = []
  for (const letter of 'CDEFGH') {
    if (await isDir(`${letter}:\\`)) roots.push(`${letter}:\\`)
  }
  return roots
}

export async function resolveFolder(name) {
  const raw = String(name ?? '').trim().replace(/^["']|["']$/g, '')
  if (!raw) throw new Error('No folder was named.')
  const home = homedir()
  const key = raw.toLowerCase().replace(/\s+folder$/, '').trim()

  if (key in KNOWN_FOLDERS) {
    const sub = KNOWN_FOLDERS[key]
    for (const p of [join(home, sub), join(home, 'OneDrive', sub)]) {
      if (await isDir(p)) return { path: p, others: [] }
    }
  }

  const drive = key.match(/^([a-z])(?::\\?|\s*drive)$/)
  if (drive) {
    const p = `${drive[1].toUpperCase()}:\\`
    if (await isDir(p)) return { path: p, others: [] }
    throw new Error(`There is no ${drive[1].toUpperCase()} drive on this machine.`)
  }

  if (isAbsolute(raw)) {
    if (await isDir(raw)) return { path: raw, others: [] }
    throw new Error(`${raw} is not a folder on this machine.`)
  }

  const otherDrives = (await driveRoots()).filter((r) => !r.startsWith('C'))
  const found = await findFolders(key, [home, ...otherDrives])
  if (!found.length) throw new Error(`No folder called "${raw}" was found.`)
  return { path: found[0], others: found.slice(1) }
}

export async function openFolder(name) {
  const r = await resolveFolder(name)
  spawn('explorer.exe', [r.path], { detached: true, stdio: 'ignore' }).unref()
  return r
}

/** What people call an app, against what the Start menu calls it. */
const APP_ALIASES = {
  'vs code': 'visual studio code', vscode: 'visual studio code', code: 'visual studio code',
  chrome: 'google chrome', edge: 'microsoft edge', word: 'word', excel: 'excel',
  'claude app': 'claude', 'claude desktop': 'claude',
}

/**
 * Open an installed app by name — "open Claude", "Antigravity open pannu".
 *
 * Matched against the Start menu's own list (list-apps.ps1): exact name
 * first, then a name starting with the request, then one containing it, the
 * shortest winning, so "claude" opens Claude rather than some "Claude Helper".
 */
export async function openApp(name) {
  const want0 = String(name ?? '').trim().toLowerCase().replace(/\s+app$/, '')
  if (!want0) throw new Error('No app was named.')
  const want = APP_ALIASES[want0] ?? want0
  const { apps } = await runPs('list-apps.ps1')
  const named = (Array.isArray(apps) ? apps : [apps]).filter((a) => a?.name && a?.id)
  const lower = (a) => a.name.toLowerCase()
  const byLength = (a, b) => a.name.length - b.name.length
  const hit =
    named.find((a) => lower(a) === want) ??
    named.filter((a) => lower(a).startsWith(want)).sort(byLength)[0] ??
    named.filter((a) => lower(a).includes(want)).sort(byLength)[0]
  if (!hit) throw new Error(`No installed app called "${name}" was found.`)
  spawn('explorer.exe', [`shell:AppsFolder\\${hit.id}`], { detached: true, stdio: 'ignore' }).unref()
  return { name: hit.name }
}

const SCREENSHOT_DIR = join(homedir(), 'Pictures', 'JARVIS')

export async function takeScreenshot() {
  await mkdir(SCREENSHOT_DIR, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const outPath = join(SCREENSHOT_DIR, `screenshot-${stamp}.png`)
  const r = await runPs('screenshot.ps1', ['-OutPath', outPath])
  return { path: r.path }
}

export async function setDarkMode(on) {
  const r = await runPs('darkmode.ps1', ['-Mode', on ? 'dark' : 'light'])
  return { mode: r.mode }
}

export function lockPc() {
  spawn('rundll32.exe', ['user32.dll,LockWorkStation'], {
    detached: true,
    stdio: 'ignore',
  }).unref()
  return { ok: true }
}

// ---------------------------------------------------------------------------
// MCP tool server
// ---------------------------------------------------------------------------

const ok = (text) => ({ content: [{ type: 'text', text }] })
const refuse = (text) => ({ isError: true, content: [{ type: 'text', text }] })

/** Turn one of readSysInfo()'s per-metric sections into a short spoken line,
 *  or say plainly that it's unavailable rather than reading a raw error. */
function describeSection(label, section, describe) {
  if (!section || typeof section !== 'object' || 'error' in section) {
    return `${label} is unavailable${section?.error ? `: ${section.error}` : '.'}`
  }
  return describe(section)
}

function describeSysInfo(info) {
  const bytesToGB = (n) => (n / 1024 ** 3).toFixed(1)
  const lines = [
    describeSection('CPU', info.cpu, (c) =>
      `CPU is at ${c.percent ?? '—'} percent${c.cores ? ` across ${c.cores} cores` : ''}.`,
    ),
    describeSection('Memory', info.memory, (m) =>
      `${bytesToGB(m.usedBytes)} of ${bytesToGB(m.totalBytes)} gigabytes of RAM in use, ` +
      `${bytesToGB(m.availableBytes)} available.`,
    ),
    describeSection('Disk', info.disk, (d) =>
      `Drive ${d.mount}: ${bytesToGB(d.freeBytes)} gigabytes free of ${bytesToGB(d.totalBytes)}, ` +
      `${d.usePercent ?? '—'} percent used.`,
    ),
    describeSection('Battery', info.battery, (b) =>
      b.hasBattery
        ? `Battery at ${b.percent ?? '—'} percent, ` +
          (b.isCharging ? 'charger plugged in and charging.' : 'charger not plugged in, running on battery.')
        : 'No battery detected.',
    ),
    // Worded so it can't be read as part of the battery line: a bare
    // "Connected via wireless." came back as "charging on wireless".
    describeSection('Network', info.network, (n) =>
      n.connected
        ? `Internet connection: ${n.type === 'wireless' ? 'Wi-Fi' : (n.type ?? 'connected')}${n.iface ? ` (${n.iface})` : ''}.`
        : 'Internet connection: not connected.',
    ),
  ]
  return lines.join(' ')
}

/** `afterTurn(fn)` runs fn once the current agent turn has finished — the
 *  bridge's own per-connection hook, used to cut Wi-Fi only after the reply
 *  about cutting it has been delivered. */
export function pcServer({ readSysInfo, afterTurn } = {}) {
  return createSdkMcpServer({
    name: 'jarvis_pc',
    version: '1.0.0',
    instructions:
      'Controls for this Windows machine: volume, brightness, Wi-Fi, and a ' +
      "few one-shot actions. Report the tool's own returned numbers — never " +
      'assume a change worked. Ask before turning Wi-Fi off, since it can ' +
      'disconnect this conversation.',
    tools: [
      tool(
        'get_system_info',
        'CPU load, RAM usage, disk space, battery and network status for this ' +
          'machine — use this for any question about storage, memory, CPU, ' +
          'battery or whether the machine is online.',
        {},
        async () => {
          if (!readSysInfo) return refuse('System info is not available.')
          const info = await readSysInfo()
          return ok(describeSysInfo(info))
        },
      ),

      tool('get_volume', 'The current system volume percentage and mute state.', {}, async () => {
        const r = await getVolume()
        return ok(`Volume is ${r.percent} percent${r.muted ? ', muted' : ''}.`)
      }),

      tool(
        'set_volume',
        'Set the system volume to an exact percentage, 0-100.',
        { percent: z.number().describe('Target volume, 0-100.') },
        async (args) => {
          try {
            const r = await setVolume(args.percent)
            return ok(`Volume is now ${r.percent} percent${r.muted ? ', muted' : ''}.`)
          } catch (err) {
            return refuse(String(err.message ?? err))
          }
        },
      ),

      tool(
        'adjust_volume',
        'Raise or lower the system volume by a relative amount. Use a ' +
          'negative number to lower it.',
        { delta: z.number().describe('Change in percentage points, e.g. 10 or -10.') },
        async (args) => {
          const r = await adjustVolume(args.delta)
          return ok(`Volume is now ${r.percent} percent${r.muted ? ', muted' : ''}.`)
        },
      ),

      tool('mute_system', 'Mute system audio.', {}, async () => {
        const r = await muteSystem()
        return ok(`Muted. Volume is ${r.percent} percent.`)
      }),

      tool('unmute_system', 'Unmute system audio.', {}, async () => {
        const r = await unmuteSystem()
        return ok(`Unmuted. Volume is ${r.percent} percent.`)
      }),

      tool(
        'get_brightness',
        'The built-in display\'s current brightness percentage, if the ' +
          'hardware exposes it.',
        {},
        async () => {
          const r = await getBrightness()
          return r.unsupported
            ? refuse(`Brightness isn't available on this display: ${r.reason}`)
            : ok(`Brightness is ${r.percent} percent.`)
        },
      ),

      tool(
        'set_brightness',
        'Set the built-in display brightness to an exact percentage, 0-100.',
        { percent: z.number().describe('Target brightness, 0-100.') },
        async (args) => {
          try {
            const r = await setBrightness(args.percent)
            return r.unsupported
              ? refuse(`Brightness isn't available on this display: ${r.reason}`)
              : ok(`Brightness is now ${r.percent} percent.`)
          } catch (err) {
            return refuse(String(err.message ?? err))
          }
        },
      ),

      tool(
        'adjust_brightness',
        'Raise or lower the display brightness by a relative amount. Use a ' +
          'negative number to lower it.',
        { delta: z.number().describe('Change in percentage points, e.g. 10 or -10.') },
        async (args) => {
          const r = await adjustBrightness(args.delta)
          return r.unsupported
            ? refuse(`Brightness isn't available on this display: ${r.reason}`)
            : ok(`Brightness is now ${r.percent} percent.`)
        },
      ),

      tool('check_wifi_status', 'Wi-Fi adapter and connection status.', {}, async () => {
        const r = await checkWifiStatus()
        if (!r.hasWifiAdapter) return ok('No wireless adapter was found on this machine.')
        if (r.radioOn === false) return ok('Wi-Fi is switched off.')
        return ok(
          r.connected
            ? `Connected to ${r.ssid}${r.signalQuality != null ? ` at ${r.signalQuality} percent signal quality` : ''}.`
            : 'The wireless adapter is present but not connected to a network.',
        )
      }),

      tool('check_internet', 'Whether this machine currently has a working internet connection.', {}, async () => {
        const r = await checkInternet()
        return ok(r.online ? 'Internet connection is working.' : 'No internet connection detected.')
      }),

      tool(
        'wifi_set',
        'Turn the Wi-Fi adapter on or off. Turning it OFF requires confirm: ' +
          'true — ask the user first ("turning off Wi-Fi may disconnect us — ' +
          'are you sure?"), wait for a yes, then call again with confirm set. ' +
          'Turning it on needs no confirmation. Once it is off you cannot ' +
          'reach the internet, so tell them in the same sentence that they ' +
          'can type "wifi on" or use the Wi-Fi button to bring it back.',
        {
          on: z.boolean().describe('true to turn Wi-Fi on, false to turn it off.'),
          confirm: z
            .boolean()
            .default(false)
            .describe('Must be true to actually turn Wi-Fi off. Ignored when on is true.'),
        },
        async (args) => {
          try {
            // Off is deferred to the end of this turn. The reply to "yes, turn
            // it off" still has to come back from the model over this very
            // connection; with the radio cut first, the turn hung for good
            // and never finished its sentence. A fixed few seconds was not
            // enough either — a considered reply can take longer than that.
            if (!args.on && args.confirm) {
              if ((await wifiRadioOn()) === null) {
                return refuse('No Wi-Fi radio was found on this machine.')
              }
              let fired = false
              const fire = () => {
                if (fired) return
                fired = true
                void wifiSet(false, true)
              }
              afterTurn?.(fire)
              // In case the turn never reports finishing.
              setTimeout(fire, WIFI_OFF_FALLBACK_MS)
              return ok(
                'Wi-Fi switches off as soon as your reply has been sent. Say ' +
                  'now, briefly, that it is going off, and that they can type ' +
                  '"wifi on" or use the Wi-Fi button to bring it back.',
              )
            }
            const r = await wifiSet(args.on, args.confirm)
            if (!r.ok) return refuse(r.error)
            return ok(`Wi-Fi is now ${r.on ? 'on' : 'off'}.`)
          } catch (err) {
            return refuse(String(err.message ?? err))
          }
        },
      ),

      tool(
        'open_folder',
        'Open a folder in File Explorer on this laptop. Pass the folder as the ' +
          'user said it: a known folder (Downloads, Documents, Desktop, ' +
          'Pictures, Music, Videos), a drive ("D drive"), a full path, or any ' +
          'folder name, which is searched for under their home folder and ' +
          'drives. Just open it — no need to ask first.',
        { name: z.string().min(1).describe('The folder, e.g. "downloads", "D drive", "jarvis".') },
        async (args) => {
          try {
            const r = await openFolder(args.name)
            return ok(
              `Opened ${r.path} in File Explorer.` +
                (r.others.length ? ` Other matches: ${r.others.join('; ')}.` : ''),
            )
          } catch (err) {
            return refuse(String(err.message ?? err))
          }
        },
      ),

      tool(
        'open_app',
        'Open an installed app on this laptop by name — Claude, Antigravity, ' +
          'VS Code, Chrome, WhatsApp, Word, Excel, or anything else in the ' +
          'Start menu. Just open it — no need to ask first.',
        { name: z.string().min(1).describe('The app as the user said it, e.g. "claude", "vs code".') },
        async (args) => {
          try {
            const r = await openApp(args.name)
            return ok(`${r.name} is opening.`)
          } catch (err) {
            return refuse(String(err.message ?? err))
          }
        },
      ),

      tool('open_notepad', 'Open Notepad.', {}, async () => {
        openNotepad()
        return ok('Notepad is open.')
      }),

      tool('open_calculator', 'Open Calculator.', {}, async () => {
        openCalculator()
        return ok('Calculator is open.')
      }),

      tool(
        'take_screenshot',
        'Capture the primary screen and save it as a PNG file. Returns the ' +
          'saved path — put it on a blade if the user wants to see it.',
        {},
        async () => {
          try {
            const r = await takeScreenshot()
            return ok(`Screenshot saved to ${r.path}`)
          } catch (err) {
            return refuse(String(err.message ?? err))
          }
        },
      ),

      tool(
        'set_dark_mode',
        'Switch Windows apps and system theme between dark and light.',
        { on: z.boolean().describe('true for dark mode, false for light mode.') },
        async (args) => {
          try {
            const r = await setDarkMode(args.on)
            return ok(`Theme is now ${r.mode}.`)
          } catch (err) {
            return refuse(String(err.message ?? err))
          }
        },
      ),

      tool('lock_pc', 'Lock the current Windows session.', {}, async () => {
        lockPc()
        return ok('Locking the session.')
      }),
    ],
  })
}
