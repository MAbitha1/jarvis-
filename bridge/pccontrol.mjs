import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdir } from 'node:fs/promises'
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

/** The machine's wireless adapters, from systeminformation — never from
 *  parsing `netsh interface show interface`, whose own "Type" column does
 *  not distinguish Wi-Fi from Ethernet. This is the one and only source the
 *  on/off toggle below is allowed to pick a target from. */
async function wirelessInterfaceNames() {
  const list = await si.wifiInterfaces().catch(() => [])
  return (Array.isArray(list) ? list : []).map((i) => i.iface).filter(Boolean)
}

export async function checkWifiStatus() {
  const [ifaces, conns] = await Promise.all([
    si.wifiInterfaces().catch(() => []),
    si.wifiConnections().catch(() => []),
  ])
  if (!Array.isArray(ifaces) || ifaces.length === 0) {
    return { hasWifiAdapter: false, connected: false }
  }
  const conn = Array.isArray(conns) ? conns[0] : null
  return {
    hasWifiAdapter: true,
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

/**
 * Turn the (one and only, discovered) wireless adapter on or off.
 *
 * Turning off requires `confirm: true` — see pcServer()'s tool description,
 * which tells the model to ask the user first and call back only once they
 * agree. Turning on never needs it. Either direction can come back reporting
 * the OS denied the admin-only call; that is returned as a normal result,
 * never retried with elevated rights.
 */
export async function wifiSet(on, confirm) {
  if (!on && !confirm) {
    throw new Error(
      'Turning Wi-Fi off needs confirmation — ask the user first, then call again with confirm: true.',
    )
  }
  const names = await wirelessInterfaceNames()
  if (names.length === 0) {
    return { ok: false, error: 'No wireless adapter was found on this machine.' }
  }
  try {
    const r = await runPs('wifi-adapter.ps1', [
      '-Name', names[0],
      '-State', on ? 'enabled' : 'disabled',
    ])
    return { ok: true, adapter: r.name, on }
  } catch (err) {
    const msg = String(err.message ?? err)
    const denied = /access is denied/i.test(msg)
    return {
      ok: false,
      error: denied
        ? 'Windows denied the request — changing an adapter\'s admin state needs ' +
          'Administrator privileges. Run the bridge as Administrator, or use ' +
          'Windows Settings to toggle Wi-Fi.'
        : msg,
    }
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
        ? `Battery at ${b.percent ?? '—'} percent, ${b.isCharging ? 'charging' : 'on battery'}.`
        : 'No battery detected.',
    ),
    describeSection('Network', info.network, (n) =>
      n.connected ? `Connected${n.type ? ` via ${n.type}` : ''}.` : 'Not connected.',
    ),
  ]
  return lines.join(' ')
}

export function pcServer({ readSysInfo } = {}) {
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
          'Turning it on needs no confirmation. May fail if the bridge is not ' +
          'running as Administrator; report that plainly if it does.',
        {
          on: z.boolean().describe('true to turn Wi-Fi on, false to turn it off.'),
          confirm: z
            .boolean()
            .default(false)
            .describe('Must be true to actually turn Wi-Fi off. Ignored when on is true.'),
        },
        async (args) => {
          try {
            const r = await wifiSet(args.on, args.confirm)
            if (!r.ok) return refuse(r.error)
            return ok(`Wi-Fi is now ${r.on ? 'on' : 'off'}.`)
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
