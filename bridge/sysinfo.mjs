import si from 'systeminformation'
import { getVolume, getBrightness } from './pccontrol.mjs'

/**
 * Live machine metrics for the System Monitor dashboard.
 *
 * Read-only, by construction: every call below is a query against
 * `systeminformation`, which only ever reads from the OS (performance
 * counters, WMI/PowerShell on Windows, /proc elsewhere) and never writes to
 * disk, spawns a user-visible process, or changes any setting. Nothing here
 * takes an argument from the browser, so there is nothing to inject either.
 *
 * Each metric is fetched independently and wrapped in its own try/catch. A
 * desktop with no battery, a sandboxed container with no /sys, or a single
 * flaky WMI call must not take the other four metrics down with it — the
 * dashboard would rather show four live numbers and one "unavailable" than
 * one error for the whole panel.
 */

/** `{ error }` on failure, otherwise whatever `fn()` resolved to. */
async function section(fn) {
  try {
    return await fn()
  } catch (err) {
    return { error: String(err?.message ?? err) }
  }
}

async function cpuInfo() {
  // currentLoad() needs two samples to compute a percentage; the library
  // keeps the previous reading internally, so only the very first call after
  // boot pays a short (~1s) delay. Every poll after that is instant.
  const load = await si.currentLoad()
  return { percent: round1(load.currentLoad), cores: load.cpus?.length ?? null }
}

async function memoryInfo() {
  const m = await si.mem()
  return {
    totalBytes: m.total,
    usedBytes: m.used,
    freeBytes: m.free,
    // `available` accounts for reclaimable cache the OS would hand back to a
    // hungry process, which is what users mean by "how much RAM do I have
    // left" — `free` alone is pessimistic on both Windows and Linux.
    availableBytes: m.available,
  }
}

async function diskInfo() {
  const drives = await si.fsSize()
  if (!Array.isArray(drives) || drives.length === 0) {
    return { error: 'no filesystem reported' }
  }
  // The system drive — whichever filesystem the bridge's own files live on —
  // rather than every removable and network drive the user has attached,
  // which is closer to what "disk usage" means on a dashboard like this one.
  const cwdRoot = process.cwd().slice(0, 3).toLowerCase() // e.g. 'c:\\' on Windows
  const main =
    drives.find((d) => String(d.mount ?? '').toLowerCase().startsWith(cwdRoot)) ??
    drives.find((d) => d.mount === '/') ??
    drives[0]
  return {
    mount: main.mount,
    totalBytes: main.size,
    usedBytes: main.used,
    freeBytes: Math.max(0, main.size - main.used),
    usePercent: round1(main.use ?? (main.size ? (main.used / main.size) * 100 : 0)),
  }
}

async function batteryInfo() {
  const b = await si.battery()
  if (!b.hasBattery) {
    return { hasBattery: false, percent: null, isCharging: null }
  }
  return {
    hasBattery: true,
    percent: typeof b.percent === 'number' ? round1(b.percent) : null,
    isCharging: Boolean(b.isCharging),
  }
}

async function networkInfo() {
  const [defaultIface, interfaces] = await Promise.all([
    si.networkInterfaceDefault(),
    si.networkInterfaces(),
  ])
  const list = Array.isArray(interfaces) ? interfaces : [interfaces]
  const iface = list.find((i) => i.iface === defaultIface) ?? list.find((i) => i.operstate === 'up')
  if (!iface) return { connected: false, iface: null, type: null }
  return {
    connected: iface.operstate === 'up',
    iface: iface.iface ?? null,
    // 'wireless' | 'wired' | 'virtual' — enough to label the reading without
    // exposing the interface's IP or MAC to the renderer.
    type: iface.type ?? null,
  }
}

const round1 = (n) => (typeof n === 'number' && Number.isFinite(n) ? Math.round(n * 10) / 10 : null)

export async function readSysInfo() {
  const [cpu, memory, disk, battery, network, audio, brightness] = await Promise.all([
    section(cpuInfo),
    section(memoryInfo),
    section(diskInfo),
    section(batteryInfo),
    section(networkInfo),
    // Same pccontrol.mjs functions the voice tools call — one implementation
    // shared by the dashboard and by "what's my volume", never two.
    section(getVolume),
    section(getBrightness),
  ])
  return { ok: true, timestamp: Date.now(), cpu, memory, disk, battery, network, audio, brightness }
}
