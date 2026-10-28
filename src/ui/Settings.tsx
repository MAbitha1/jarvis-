import { useEffect, useState } from 'react'
import { useStore } from '../store'
import {
  candidateVoices,
  browserVoiceName,
  selectVoice,
  getSpeechRate,
  setSpeechRate,
  getPreferBrowserVoice,
  setPreferBrowserVoice,
} from '../lib/tts'
import { caps } from '../lib/capabilities'
import * as history from '../lib/history'
import { isTypingTarget } from '../lib/keys'
import {
  LANGUAGE_OPTIONS,
  getRecognitionLanguage,
  setRecognitionLanguage,
} from '../lib/language'

/**
 * Assistant preferences. Press S to show it, same idiom as Diagnostics (D).
 *
 * Everything here is a thin front end onto settings that already exist
 * somewhere — the voice list tts.ts already ranks, the accent store the
 * ui_theme tool already writes to — so this panel never invents a second
 * source of truth for anything it exposes.
 */

const ACCENTS: Array<{ name: string; value: string | null }> = [
  { name: 'Default', value: null },
  { name: 'Amber', value: '#ffb547' },
  { name: 'Violet', value: '#c77dff' },
  { name: 'Green', value: '#5affc8' },
  { name: 'Red', value: '#ff6b6b' },
]

export function Settings({
  onNewConversation,
  onOpenConversation,
}: {
  onNewConversation: () => void
  onOpenConversation: (id: string) => void
}) {
  const [open, setOpen] = useState(false)
  const ui = useStore((s) => s.ui)
  const applyUi = useStore((s) => s.applyUi)
  const [conversations, setConversations] = useState<history.ConversationRecord[]>([])
  const [currentId, setCurrentId] = useState(() => history.getCurrentId())

  const refreshHistory = () => {
    setConversations(history.loadAll())
    setCurrentId(history.getCurrentId())
  }

  // Local mirrors of module-level tts.ts state, so moving a slider re-renders
  // this panel without tts.ts needing to know React exists.
  const [rate, setRate] = useState(() => getSpeechRate())
  const [preferBrowser, setPreferBrowser] = useState(() => getPreferBrowserVoice())
  const [voiceName, setVoiceName] = useState(() => browserVoiceName())
  const [voices, setVoices] = useState(() => candidateVoices())
  const [lang, setLang] = useState(() => getRecognitionLanguage())

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target)) return
      if (e.key === 's' && !e.repeat && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault()
        setOpen((o) => !o)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Voices load asynchronously; refresh both lists each time the panel opens
  // — conversations may have changed since it was last shown.
  useEffect(() => {
    if (open) {
      setVoices(candidateVoices())
      refreshHistory()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  if (!open) return null

  const cloudAvailable = caps().tts

  return (
    <div className="settings" role="dialog" aria-label="Settings">
      <div className="settings-head">
        SETTINGS · <kbd>S</kbd> to close
      </div>

      <div className="settings-sec">VOICE</div>
      <select
        className="settings-select"
        value={voiceName}
        onChange={(e) => {
          selectVoice(e.target.value)
          setVoiceName(browserVoiceName())
        }}
      >
        {voices.length === 0 && <option>No voices found</option>}
        {voices.map((v) => (
          <option key={v.name} value={v.name}>
            {v.name}
          </option>
        ))}
      </select>
      {cloudAvailable && (
        <label className="settings-row">
          <input
            type="checkbox"
            checked={preferBrowser}
            onChange={(e) => {
              setPreferBrowserVoice(e.target.checked)
              setPreferBrowser(e.target.checked)
            }}
          />
          Prefer the browser voice over ElevenLabs (faster, lower quality)
        </label>
      )}
      {!cloudAvailable && (
        <div className="settings-note">
          No ElevenLabs key configured — using the browser's own voices.
        </div>
      )}

      <div className="settings-sec">RECOGNITION LANGUAGE</div>
      <select
        className="settings-select"
        value={lang}
        onChange={(e) => {
          setRecognitionLanguage(e.target.value)
          setLang(e.target.value)
        }}
      >
        {LANGUAGE_OPTIONS.map((o) => (
          <option key={o.code} value={o.code}>
            {o.label}
          </option>
        ))}
      </select>
      <div className="settings-note">
        Takes effect the next time he starts listening. Browser speech
        recognition is never perfectly accurate — it depends on your
        microphone, accent and surroundings regardless of this setting.
      </div>

      <div className="settings-sec">SPEECH SPEED</div>
      <div className="settings-row">
        <input
          type="range"
          min={0.6}
          max={1.6}
          step={0.05}
          value={rate}
          onChange={(e) => {
            const r = Number(e.target.value)
            setSpeechRate(r)
            setRate(getSpeechRate())
          }}
        />
        <span className="settings-value">{rate.toFixed(2)}x</span>
      </div>

      <div className="settings-sec">ACCENT COLOUR</div>
      <div className="settings-swatches">
        {ACCENTS.map((a) => (
          <button
            key={a.name}
            className={`settings-swatch${ui.accent === a.value ? ' active' : ''}`}
            style={{ background: a.value ?? 'var(--interface)' }}
            title={a.name}
            onClick={() => applyUi({ accent: a.value })}
          />
        ))}
      </div>

      <div className="settings-sec">CONVERSATIONS</div>
      <button
        className="settings-btn settings-btn-wide"
        onClick={() => {
          onNewConversation()
          refreshHistory()
        }}
      >
        + New conversation
      </button>
      {conversations.length === 0 && (
        <div className="settings-note">Nothing saved yet — talk to him first.</div>
      )}
      <div className="settings-history">
        {conversations.map((c) => (
          <div key={c.id} className={`settings-hist-row${c.id === currentId ? ' active' : ''}`}>
            <button
              className="settings-hist-open"
              onClick={() => {
                onOpenConversation(c.id)
                refreshHistory()
              }}
              title="Open this conversation"
            >
              <span className="settings-hist-when">
                {new Date(c.updatedAt).toLocaleString(undefined, {
                  month: 'short',
                  day: 'numeric',
                  hour: 'numeric',
                  minute: '2-digit',
                })}
              </span>
              <span className="settings-hist-count">{c.turns.length} turns</span>
            </button>
            <button
              className="settings-hist-del"
              onClick={() => {
                history.deleteConversation(c.id)
                refreshHistory()
              }}
              title="Delete"
            >
              ✕
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}
