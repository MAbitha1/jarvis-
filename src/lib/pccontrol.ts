import { BRIDGE_HTTP_URL } from '../config'

/**
 * Thin client for the bridge's /pc/* endpoints (see server.mjs) — the same
 * functions the jarvis_pc voice tools call, reached directly over HTTP so a
 * button click doesn't have to wait on a model turn. Every function here
 * resolves to the bridge's actual returned state; none of them guess.
 */

export type VolumeState = { ok: boolean; percent: number; muted: boolean; error?: string }
export type BrightnessState = { ok: boolean; percent?: number; unsupported?: boolean; reason?: string; error?: string }
export type WifiState = {
  ok: boolean
  hasWifiAdapter: boolean
  adapter?: string
  connected?: boolean
  ssid?: string | null
  signalQuality?: number | null
  online?: boolean
  error?: string
}
export type ActionResult = { ok: boolean; error?: string; path?: string; mode?: string }

const FETCH_TIMEOUT_MS = 10_000

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BRIDGE_HTTP_URL}${path}`, {
    ...init,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: init?.body ? { 'content-type': 'application/json' } : undefined,
  })
  const body = (await res.json().catch(() => ({ ok: false, error: `status ${res.status}` }))) as T
  return body
}

const post = <T>(path: string, data?: unknown) =>
  call<T>(path, { method: 'POST', body: data === undefined ? undefined : JSON.stringify(data) })

export const getVolume = () => call<VolumeState>('/pc/volume')
export const setVolume = (percent: number) => post<VolumeState>('/pc/volume', { percent })
export const adjustVolume = (delta: number) => post<VolumeState>('/pc/volume/adjust', { delta })
export const muteSystem = () => post<VolumeState>('/pc/volume/mute')
export const unmuteSystem = () => post<VolumeState>('/pc/volume/unmute')

export const getBrightness = () => call<BrightnessState>('/pc/brightness')
export const setBrightness = (percent: number) => post<BrightnessState>('/pc/brightness', { percent })
export const adjustBrightness = (delta: number) => post<BrightnessState>('/pc/brightness/adjust', { delta })

export const getWifiStatus = () => call<WifiState>('/pc/wifi')
export const setWifi = (on: boolean, confirm = false) => post<WifiState>('/pc/wifi', { on, confirm })

export const openNotepad = () => post<ActionResult>('/pc/notepad')
export const openCalculator = () => post<ActionResult>('/pc/calculator')
export const takeScreenshot = () => post<ActionResult>('/pc/screenshot')
export const setDarkMode = (on: boolean) => post<ActionResult>('/pc/darkmode', { on })
export const lockPc = () => post<ActionResult>('/pc/lock')
