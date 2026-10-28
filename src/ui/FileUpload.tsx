import { useRef, useState } from 'react'
import { BRIDGE_HTTP_URL } from '../config'

/**
 * File Assistant — upload a PDF or TXT, JARVIS reads it and summarises.
 *
 * Posts the raw bytes to the bridge's /upload endpoint (see server.mjs /
 * files.mjs), then hands the returned id to JARVIS through the normal
 * respond() pipeline — the same path speech and typed chat use — so the
 * summary that comes back is spoken and shown exactly like any other answer.
 */

const MAX_BYTES = 10 * 1024 * 1024
const ALLOWED = ['.pdf', '.txt']

type Status = 'idle' | 'uploading' | 'error'

export function FileUpload({ onUploaded }: { onUploaded: (prompt: string) => void }) {
  const [status, setStatus] = useState<Status>('idle')
  const [error, setError] = useState<string | null>(null)
  const input = useRef<HTMLInputElement>(null)

  const pick = () => input.current?.click()

  const upload = async (file: File) => {
    setError(null)
    const ext = file.name.slice(file.name.lastIndexOf('.')).toLowerCase()
    if (!ALLOWED.includes(ext)) {
      setStatus('error')
      setError('Only .pdf and .txt files are supported.')
      return
    }
    if (file.size === 0) {
      setStatus('error')
      setError('That file is empty.')
      return
    }
    if (file.size > MAX_BYTES) {
      setStatus('error')
      setError(`That file is too large — the limit is ${MAX_BYTES / 1024 / 1024} MB.`)
      return
    }

    setStatus('uploading')
    try {
      const res = await fetch(`${BRIDGE_HTTP_URL}/upload`, {
        method: 'POST',
        headers: {
          'content-type': 'application/octet-stream',
          'x-jarvis-filename': encodeURIComponent(file.name),
        },
        body: file,
      })
      if (!res.ok) throw new Error(await res.text())
      const { id, filename } = (await res.json()) as { id: string; filename: string }
      setStatus('idle')
      onUploaded(`I've uploaded a file called "${filename}" (id ${id}). Please summarise it.`)
    } catch (err) {
      setStatus('error')
      setError(err instanceof Error ? err.message : 'Upload failed.')
    }
  }

  return (
    <div className="upload">
      <input
        ref={input}
        type="file"
        accept=".pdf,.txt"
        className="upload-input"
        onChange={(e) => {
          const file = e.target.files?.[0]
          e.target.value = ''
          if (file) void upload(file)
        }}
      />
      <button
        className={`hud-icon-btn${status === 'uploading' ? ' active' : ''}`}
        onClick={pick}
        disabled={status === 'uploading'}
        title="Upload a PDF or TXT file (10 MB max)"
      >
        {status === 'uploading' ? 'UPLOADING…' : 'UPLOAD'}
      </button>
      {status === 'error' && error && <div className="upload-error">{error}</div>}
    </div>
  )
}
