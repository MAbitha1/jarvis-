/**
 * Speech-recognition language — user-configurable, not hardcoded.
 *
 * Both recognition engines read this: the browser's own SpeechRecognition
 * (voice.ts's `rec.lang`) and the bridge's ElevenLabs Scribe proxy (passed as
 * a `lang` query param on /stt, see server.mjs). Previously `rec.lang` was
 * hardcoded to 'en-GB', which is a real source of "it keeps misinterpreting
 * what I said" for anyone speaking a different English variant — Chrome's
 * recognizer is tuned per locale, and en-GB biases it toward British
 * pronunciation and vocabulary.
 */

const KEY = 'jarvis.lang'

/** English (India) — a reasonable, explicitly-requested default; change it
 *  in Settings if your own accent or language is better served by another. */
export const DEFAULT_LANG = 'en-IN'

export const LANGUAGE_OPTIONS: Array<{ code: string; label: string }> = [
  { code: 'en-IN', label: 'English (India)' },
  { code: 'en-US', label: 'English (US)' },
  { code: 'en-GB', label: 'English (UK)' },
  { code: 'en-AU', label: 'English (Australia)' },
  { code: 'hi-IN', label: 'Hindi (India)' },
]

export function getRecognitionLanguage(): string {
  try {
    return localStorage.getItem(KEY) || DEFAULT_LANG
  } catch {
    return DEFAULT_LANG
  }
}

/** Fired after a change, so a recogniser already running can pick it up
 *  without waiting for its next natural restart — see voice.ts's listener. */
export const LANG_CHANGED_EVENT = 'jarvis:lang-changed'

export function setRecognitionLanguage(code: string): void {
  try {
    localStorage.setItem(KEY, code)
  } catch {
    /* session-only if storage is unavailable */
  }
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(LANG_CHANGED_EVENT, { detail: code }))
  }
}

/** ElevenLabs Scribe takes a bare ISO-639-1 code (e.g. "en", "hi"), not a
 *  dialect tag — it has no notion of "English (India)" vs "English (UK)",
 *  only the language. Scribe also auto-detects well on its own, so this is a
 *  hint rather than something it strictly requires. */
export function scribeLanguageCode(bcp47: string): string {
  return bcp47.split('-')[0]
}
