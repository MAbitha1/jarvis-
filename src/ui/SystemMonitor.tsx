import { useEffect, useRef, useState } from 'react'
import { BACKEND, BRIDGE_HTTP_URL } from '../config'
import { isTypingTarget } from '../lib/keys'
import * as pc from '../lib/pccontrol'

/**
 * The System Monitor — CPU, memory, disk, battery, network, audio and
 * brightness, read off the machine the bridge runs on, plus the controls
 * for the ones that can be controlled (volume, brightness, Wi-Fi, and a
 * handful of one-shot actions).
 *
 * Modeled directly on Diagnostics.tsx: a self-contained overlay that owns its
 * own open/closed state and its own keybinding, so mounting it in App.tsx is
 * a one-line addition. Press M to show it.
 *
 * Every control here calls straight into src/lib/pccontrol.ts, which hits
 * the bridge's /pc/* endpoints — the exact same functions the jarvis_pc
 * voice tools call server-side (see bridge/pccontrol.mjs). A button and the
 * matching voice command can never drift apart because there is only ever
 * one implementation underneath either of them.
 *
 * Metrics only exist because `bridge/server.mjs` is a Node process that can
 * read the OS — the browser alone has no API for any of this. So in 'direct'
 * mode (no bridge) or whenever the bridge is unreachable, this reports that
 * plainly instead of pretending to have numbers it doesn't.
 */

type Section<T> = T | { error: string }

type SysInfo = {
  ok: boolean
  timestamp: number
  cpu: Section<{ percent: number | null; cores: number | null }>
  memory: Section<{
    totalBytes: number
    usedBytes: number
    freeBytes: number
    availableBytes: number
  }>
  disk: Section<{
    mount: string
    totalBytes: number
    usedBytes: number
    freeBytes: number
    usePercent: number | null
  }>
  battery: Section<{ hasBattery: boolean; percent: number | null; isCharging: boolean | null }>
  network: Section<{ connected: boolean; iface: string | null; type: string | null }>
  audio: Section<{ percent: number; muted: boolean }>
  brightness: { percent: number } | { unsupported: true; reason: string } | { error: string }
}

const POLL_MS = 3000
/**
 * Generous relative to the poll cadence on purpose. Each /sysinfo request
 * costs roughly 1-1.3s on Windows — systeminformation shells out to
 * PowerShell/WMI for battery, disk and network — so a tight timeout here
 * flagged the bridge as "unreachable" on nothing worse than normal variance
 * in how long those child processes take to start. Measured on this machine:
 * every call landed under 1.5s; 4s leaves headroom without ever threatening
 * to overlap the next poll.
 */
const FETCH_TIMEOUT_MS = 4000
/** How many polls in a row have to fail before the panel actually says so.
 *  One slow tick is noise; real unreachability is not. */
const FAILURES_BEFORE_UNREACHABLE = 2
/** How long a slider sits still before its drag is actually sent — each
 *  change spawns a real PowerShell process on the bridge, so firing one per
 *  pixel of drag would be both wasteful and visibly laggy. */
const SLIDER_DEBOUNCE_MS = 300
/** How long a control's success/error line stays up before fading, so a
 *  string of quick actions doesn't leave a wall of old messages. */
const STATUS_TTL_MS = 4000

function isError<T>(v: Section<T>): v is { error: string } {
  return typeof v === 'object' && v !== null && 'error' in v
}

function bytesToGB(n: number): string {
  return (n / 1024 ** 3).toFixed(1)
}

function Bar({ pct }: { pct: number | null | undefined }) {
  const v = typeof pct === 'number' && Number.isFinite(pct) ? Math.max(0, Math.min(100, pct)) / 100 : 0
  // `--v` is read by `.hud-bar::after` (see index.css) — the one inline style
  // the design system allows, same mechanism the model's own panels use.
  return <div className="hud-bar sysmon-bar" style={{ '--v': v } as React.CSSProperties} />
}

function Tile({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="sysmon-tile">
      <span className="hud-unit">{label}</span>
      {children}
    </div>
  )
}

/** One line of success/error text under a control, clearing itself after
 *  STATUS_TTL_MS — the same "say what happened, then get out of the way"
 *  idiom the rest of the HUD uses for its own error banner. */
function useStatus(): [string | null, (msg: string | null) => void] {
  const [msg, setMsg] = useState<string | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const set = (m: string | null) => {
    if (timer.current) clearTimeout(timer.current)
    setMsg(m)
    if (m) timer.current = setTimeout(() => setMsg(null), STATUS_TTL_MS)
  }
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])
  return [msg, set]
}

function Status({ text, failed }: { text: string | null; failed?: boolean }) {
  if (!text) return null
  return <span className={`sysmon-status${failed ? ' failed' : ''}`}>{text}</span>
}

export function SystemMonitor() {
  const [open, setOpen] = useState(false)
  const [data, setData] = useState<SysInfo | null>(null)
  const [status, setStatus] = useState<'loading' | 'ok' | 'unreachable'>('loading')
  const timer = useRef<ReturnType<typeof setInterval> | null>(null)
  const inFlightRef = useRef(false)
  const failuresRef = useRef(0)
  const cancelledRef = useRef(false)

  // -- volume -----------------------------------------------------------
  const [volumeDraft, setVolumeDraft] = useState<number | null>(null)
  const [volumeBusy, setVolumeBusy] = useState(false)
  const [volumeMsg, setVolumeMsg] = useStatus()
  const volumeDebounce = useRef<ReturnType<typeof setTimeout> | null>(null)

  // -- brightness ---------------------------------------------------------
  const [brightnessDraft, setBrightnessDraft] = useState<number | null>(null)
  const [brightnessBusy, setBrightnessBusy] = useState(false)
  const [brightnessMsg, setBrightnessMsg] = useStatus()
  const brightnessDebounce = useRef<ReturnType<typeof setTimeout> | null>(null)

  // -- wifi -----------------------------------------------------------
  const [wifi, setWifiState] = useState<pc.WifiState | null>(null)
  const [wifiBusy, setWifiBusy] = useState(false)
  const [wifiMsg, setWifiMsg] = useStatus()

  // -- one-shot actions -----------------------------------------------------
  const [actionBusy, setActionBusy] = useState<string | null>(null)
  const [actionMsg, setActionMsg] = useStatus()

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target)) return
      if (e.key === 'm' && !e.repeat && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault()
        setOpen((o) => !o)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const refreshWifi = async () => {
    try {
      setWifiState(await pc.getWifiStatus())
    } catch {
      setWifiState({ ok: false, hasWifiAdapter: false, error: 'unreachable' })
    }
  }

  // Polling lives entirely inside this effect, keyed on `open` — the interval
  // is created only while the panel is visible and torn down the moment it
  // isn't, whether that's the user pressing M again or this component
  // unmounting. Nothing here outlives the panel being on screen.
  useEffect(() => {
    if (!open) return

    if (BACKEND !== 'bridge') {
      setStatus('unreachable')
      return
    }

    cancelledRef.current = false

    const poll = async () => {
      // A slow response must not stack a second request on top of it — skip
      // this tick rather than letting requests pile up against a bridge that
      // is already behind.
      if (inFlightRef.current) return
      inFlightRef.current = true
      try {
        const res = await fetch(`${BRIDGE_HTTP_URL}/sysinfo`, {
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        })
        if (!res.ok) throw new Error(`status ${res.status}`)
        const json = (await res.json()) as SysInfo
        if (cancelledRef.current) return
        failuresRef.current = 0
        setData(json)
        setStatus('ok')
      } catch {
        if (cancelledRef.current) return
        failuresRef.current += 1
        if (failuresRef.current >= FAILURES_BEFORE_UNREACHABLE) setStatus('unreachable')
      } finally {
        inFlightRef.current = false
      }
    }

    setStatus((s) => (s === 'ok' ? s : 'loading'))
    void poll()
    void refreshWifi()
    timer.current = setInterval(poll, POLL_MS)

    return () => {
      cancelledRef.current = true
      if (timer.current) clearInterval(timer.current)
      timer.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const manualRefresh = () => {
    inFlightRef.current = false // a manual refresh always gets to run now
    failuresRef.current = 0
    void (async () => {
      try {
        const res = await fetch(`${BRIDGE_HTTP_URL}/sysinfo`, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
        if (!res.ok) throw new Error(`status ${res.status}`)
        setData((await res.json()) as SysInfo)
        setStatus('ok')
      } catch {
        setStatus('unreachable')
      }
    })()
    void refreshWifi()
  }

  if (!open) return null

  const audio = data && !isError(data.audio) ? data.audio : null
  const brightness = data && !('error' in data.brightness) ? data.brightness : null
  const brightnessUnsupported = brightness && 'unsupported' in brightness

  const volumeShown = volumeDraft ?? audio?.percent ?? 0

  // Applied the instant a write's own response confirms a new value, rather
  // than waiting on the next poll tick (up to 3s away) — the headline number
  // and the "what just happened" line should never disagree about what the
  // machine is actually at right now.
  const applyAudio = (percent: number, muted: boolean) =>
    setData((d) => (d ? { ...d, audio: { percent, muted } } : d))
  const applyBrightness = (percent: number) =>
    setData((d) => (d ? { ...d, brightness: { percent } } : d))

  const queueVolume = (percent: number) => {
    setVolumeDraft(percent)
    if (volumeDebounce.current) clearTimeout(volumeDebounce.current)
    volumeDebounce.current = setTimeout(async () => {
      setVolumeBusy(true)
      try {
        const r = await pc.setVolume(percent)
        if (!r.ok) throw new Error(r.error ?? 'failed')
        applyAudio(r.percent, r.muted)
        setVolumeMsg(`Volume set to ${r.percent}%${r.muted ? ' (muted)' : ''}.`)
      } catch (err) {
        setVolumeMsg(`Couldn't set volume: ${(err as Error).message}`)
      } finally {
        setVolumeBusy(false)
        setVolumeDraft(null)
      }
    }, SLIDER_DEBOUNCE_MS)
  }

  const runVolumeAction = (fn: () => Promise<pc.VolumeState>, verb: string) => async () => {
    setVolumeBusy(true)
    try {
      const r = await fn()
      if (!r.ok) throw new Error(r.error ?? 'failed')
      applyAudio(r.percent, r.muted)
      setVolumeMsg(`${verb}: ${r.percent}%${r.muted ? ', muted' : ''}.`)
    } catch (err) {
      setVolumeMsg(`Couldn't ${verb.toLowerCase()}: ${(err as Error).message}`)
    } finally {
      setVolumeBusy(false)
    }
  }

  const brightnessShown = brightnessDraft ?? (brightness && !brightnessUnsupported ? brightness.percent : 0)

  const queueBrightness = (percent: number) => {
    setBrightnessDraft(percent)
    if (brightnessDebounce.current) clearTimeout(brightnessDebounce.current)
    brightnessDebounce.current = setTimeout(async () => {
      setBrightnessBusy(true)
      try {
        const r = await pc.setBrightness(percent)
        if ('unsupported' in r || !r.ok) throw new Error(('reason' in r && r.reason) || r.error || 'unsupported')
        applyBrightness(r.percent as number)
        setBrightnessMsg(`Brightness set to ${r.percent}%.`)
      } catch (err) {
        setBrightnessMsg(`Couldn't set brightness: ${(err as Error).message}`)
      } finally {
        setBrightnessBusy(false)
        setBrightnessDraft(null)
      }
    }, SLIDER_DEBOUNCE_MS)
  }

  const runBrightnessAdjust = (delta: number) => async () => {
    setBrightnessBusy(true)
    try {
      const r = await pc.adjustBrightness(delta)
      if ('unsupported' in r || !r.ok) throw new Error(('reason' in r && r.reason) || r.error || 'unsupported')
      applyBrightness(r.percent as number)
      setBrightnessMsg(`Brightness is now ${r.percent}%.`)
    } catch (err) {
      setBrightnessMsg(`Couldn't adjust brightness: ${(err as Error).message}`)
    } finally {
      setBrightnessBusy(false)
    }
  }

  const wifiOn = async () => {
    setWifiBusy(true)
    try {
      const r = await pc.setWifi(true)
      if (!r.ok) throw new Error(r.error ?? 'failed')
      setWifiMsg('Wi-Fi is on.')
      await refreshWifi()
    } catch (err) {
      setWifiMsg(`Couldn't turn Wi-Fi on: ${(err as Error).message}`)
    } finally {
      setWifiBusy(false)
    }
  }

  const wifiOff = async () => {
    if (!window.confirm('Turning off Wi-Fi may disconnect this session. Turn it off anyway?')) return
    setWifiBusy(true)
    try {
      const r = await pc.setWifi(false, true)
      if (!r.ok) throw new Error(r.error ?? 'failed')
      setWifiMsg('Wi-Fi is off.')
      await refreshWifi()
    } catch (err) {
      setWifiMsg(`Couldn't turn Wi-Fi off: ${(err as Error).message}`)
    } finally {
      setWifiBusy(false)
    }
  }

  const runAction = (key: string, fn: () => Promise<pc.ActionResult>, onOk: (r: pc.ActionResult) => string) => async () => {
    setActionBusy(key)
    try {
      const r = await fn()
      if (!r.ok) throw new Error(r.error ?? 'failed')
      setActionMsg(onOk(r))
    } catch (err) {
      setActionMsg(`Failed: ${(err as Error).message}`)
    } finally {
      setActionBusy(null)
    }
  }

  return (
    <div className="sysmon" aria-live="polite">
      <div className="sysmon-head">
        SYSTEM MONITOR · M to close
        <button
          className="sysmon-refresh"
          onClick={manualRefresh}
          disabled={status === 'loading'}
          aria-label="Refresh system metrics"
          title="Refresh"
        >
          ⟳
        </button>
      </div>

      {status === 'unreachable' && (
        <p className="p-empty sysmon-note">
          {BACKEND === 'bridge'
            ? 'Bridge unreachable — start it with `npm run bridge`.'
            : 'Unavailable in direct mode — system metrics need the local bridge.'}
        </p>
      )}

      {status === 'loading' && <p className="p-empty sysmon-note">Reading system metrics…</p>}

      {status === 'ok' && data && (
        <>
          <div className="sysmon-grid">
            <Tile label="CPU LOAD">
              {isError(data.cpu) ? (
                <p className="p-empty">unavailable</p>
              ) : (
                <>
                  <span className="hud-metric sysmon-metric">
                    {data.cpu.percent ?? '—'}
                    <span className="sysmon-unit-inline">%</span>
                  </span>
                  <Bar pct={data.cpu.percent} />
                  {data.cpu.cores != null && <span className="hud-sub">{data.cpu.cores} cores</span>}
                </>
              )}
            </Tile>

            <Tile label="MEMORY">
              {isError(data.memory) ? (
                <p className="p-empty">unavailable</p>
              ) : (
                <>
                  <span className="hud-metric sysmon-metric">
                    {bytesToGB(data.memory.usedBytes)}
                    <span className="sysmon-unit-inline">GB</span>
                  </span>
                  <Bar pct={(data.memory.usedBytes / data.memory.totalBytes) * 100} />
                  <span className="hud-sub">
                    {bytesToGB(data.memory.availableBytes)} GB available of {bytesToGB(data.memory.totalBytes)} GB
                  </span>
                </>
              )}
            </Tile>

            <Tile label="DISK">
              {isError(data.disk) ? (
                <p className="p-empty">unavailable</p>
              ) : (
                <>
                  <span className="hud-metric sysmon-metric">
                    {bytesToGB(data.disk.freeBytes)}
                    <span className="sysmon-unit-inline">GB free</span>
                  </span>
                  <Bar pct={data.disk.usePercent} />
                  <span className="hud-sub">
                    {data.disk.mount} · {bytesToGB(data.disk.usedBytes)} of {bytesToGB(data.disk.totalBytes)} GB used
                  </span>
                </>
              )}
            </Tile>

            <Tile label="BATTERY">
              {isError(data.battery) ? (
                <p className="p-empty">unavailable</p>
              ) : !data.battery.hasBattery ? (
                <p className="hud-sub">no battery detected</p>
              ) : (
                <>
                  <span className="hud-metric sysmon-metric">
                    {data.battery.percent ?? '—'}
                    <span className="sysmon-unit-inline">%</span>
                  </span>
                  <Bar pct={data.battery.percent} />
                  <span className="hud-sub">{data.battery.isCharging ? 'charging' : 'on battery'}</span>
                </>
              )}
            </Tile>

            <Tile label="NETWORK">
              {isError(data.network) ? (
                <p className="p-empty">unavailable</p>
              ) : (
                <span className={data.network.connected ? 'hud-hot' : 'hud-dim'}>
                  {data.network.connected
                    ? `connected${data.network.type ? ` · ${data.network.type}` : ''}`
                    : 'no connection'}
                </span>
              )}
            </Tile>

            <Tile label="VOLUME">
              {audio ? (
                <>
                  <span className="hud-metric sysmon-metric">
                    {volumeShown}
                    <span className="sysmon-unit-inline">%{audio.muted ? ' · muted' : ''}</span>
                  </span>
                  <div className="settings-row sysmon-control-row">
                    <input
                      type="range"
                      min={0}
                      max={100}
                      value={volumeShown}
                      disabled={volumeBusy}
                      aria-label="System volume"
                      onChange={(e) => queueVolume(Number(e.target.value))}
                    />
                  </div>
                  <div className="sysmon-btn-group">
                    <button
                      className="settings-btn"
                      disabled={volumeBusy}
                      aria-label="Decrease volume"
                      onClick={runVolumeAction(() => pc.adjustVolume(-5), 'Volume')}
                    >
                      −
                    </button>
                    <button
                      className="settings-btn"
                      disabled={volumeBusy}
                      aria-label="Increase volume"
                      onClick={runVolumeAction(() => pc.adjustVolume(5), 'Volume')}
                    >
                      +
                    </button>
                    <button
                      className="settings-btn"
                      disabled={volumeBusy}
                      onClick={runVolumeAction(
                        () => (audio.muted ? pc.unmuteSystem() : pc.muteSystem()),
                        audio.muted ? 'Unmuted' : 'Muted',
                      )}
                    >
                      {audio.muted ? 'Unmute' : 'Mute'}
                    </button>
                  </div>
                  <Status text={volumeMsg} failed={volumeMsg?.startsWith("Couldn't")} />
                </>
              ) : (
                <p className="p-empty">unavailable</p>
              )}
            </Tile>

            <Tile label="BRIGHTNESS">
              {brightnessUnsupported ? (
                <p className="hud-sub">
                  {'reason' in brightness ? brightness.reason : 'Not supported on this display.'}
                </p>
              ) : brightness ? (
                <>
                  <span className="hud-metric sysmon-metric">
                    {brightnessShown}
                    <span className="sysmon-unit-inline">%</span>
                  </span>
                  <div className="settings-row sysmon-control-row">
                    <input
                      type="range"
                      min={0}
                      max={100}
                      value={brightnessShown}
                      disabled={brightnessBusy}
                      aria-label="Display brightness"
                      onChange={(e) => queueBrightness(Number(e.target.value))}
                    />
                  </div>
                  <div className="sysmon-btn-group">
                    <button className="settings-btn" disabled={brightnessBusy} aria-label="Decrease brightness" onClick={runBrightnessAdjust(-10)}>
                      −
                    </button>
                    <button className="settings-btn" disabled={brightnessBusy} aria-label="Increase brightness" onClick={runBrightnessAdjust(10)}>
                      +
                    </button>
                  </div>
                  <Status text={brightnessMsg} failed={brightnessMsg?.startsWith("Couldn't")} />
                </>
              ) : (
                <p className="p-empty">unavailable</p>
              )}
            </Tile>

            <Tile label="WI-FI">
              {wifi?.hasWifiAdapter ? (
                <>
                  <span className={wifi.connected ? 'hud-hot' : 'hud-dim'}>
                    {wifi.connected ? `${wifi.ssid ?? 'connected'}${wifi.signalQuality != null ? ` · ${wifi.signalQuality}%` : ''}` : 'not connected'}
                  </span>
                  <span className="hud-sub">{wifi.adapter}</span>
                  <div className="sysmon-btn-group">
                    <button className="settings-btn" disabled={wifiBusy} onClick={wifiOn}>
                      Wi-Fi On
                    </button>
                    <button className="settings-btn" disabled={wifiBusy} onClick={wifiOff}>
                      Wi-Fi Off
                    </button>
                  </div>
                  <Status text={wifiMsg} failed={wifiMsg?.startsWith("Couldn't")} />
                </>
              ) : (
                <p className="p-empty">{wifi ? 'no adapter found' : 'checking…'}</p>
              )}
            </Tile>
          </div>

          <div className="sysmon-actions">
            <span className="hud-unit">ACTIONS</span>
            <div className="sysmon-btn-group sysmon-actions-row">
              <button
                className="settings-btn"
                disabled={actionBusy !== null}
                onClick={runAction('notepad', pc.openNotepad, () => 'Notepad opened.')}
              >
                {actionBusy === 'notepad' ? '…' : 'Notepad'}
              </button>
              <button
                className="settings-btn"
                disabled={actionBusy !== null}
                onClick={runAction('calc', pc.openCalculator, () => 'Calculator opened.')}
              >
                {actionBusy === 'calc' ? '…' : 'Calculator'}
              </button>
              <button
                className="settings-btn"
                disabled={actionBusy !== null}
                onClick={runAction('shot', pc.takeScreenshot, (r) => `Saved to ${r.path}`)}
              >
                {actionBusy === 'shot' ? '…' : 'Screenshot'}
              </button>
              <button
                className="settings-btn"
                disabled={actionBusy !== null}
                onClick={runAction('dark', () => pc.setDarkMode(true), () => 'Dark mode on.')}
              >
                {actionBusy === 'dark' ? '…' : 'Dark Mode'}
              </button>
              <button
                className="settings-btn"
                disabled={actionBusy !== null}
                onClick={runAction('light', () => pc.setDarkMode(false), () => 'Light mode on.')}
              >
                {actionBusy === 'light' ? '…' : 'Light Mode'}
              </button>
              <button
                className="settings-btn"
                disabled={actionBusy !== null}
                onClick={runAction('lock', pc.lockPc, () => 'Locking…')}
              >
                {actionBusy === 'lock' ? '…' : 'Lock PC'}
              </button>
            </div>
            <Status text={actionMsg} failed={actionMsg?.startsWith('Failed')} />
          </div>

          <div className="sysmon-updated">
            Updated {new Date(data.timestamp).toLocaleTimeString()}
          </div>
        </>
      )}
    </div>
  )
}
