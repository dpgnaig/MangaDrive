import { useEffect, useRef, useState } from 'react'
import api from '../lib/api'

interface MentionUser { id: string; displayName: string; avatarUrl: string }

/**
 * Comment composer with @mention autocomplete. Owns its own draft text: the
 * visible text keeps mentions human-readable ("@Tên"), while onSubmit receives
 * the content with mentions serialized as tokens "@[Tên](userId)" so the backend
 * can resolve who to notify and the renderer can highlight + link them.
 */
export default function CommentInput({ placeholder, autoFocus, compact, avatarUrl, onSubmit, onCancel }: {
  placeholder?: string
  autoFocus?: boolean
  compact?: boolean
  avatarUrl?: string
  onSubmit: (content: string) => void | Promise<void>
  onCancel?: () => void
}) {
  const [draft, setDraft] = useState('')
  // Confirmed picks, so we can turn "@Tên" back into "@[Tên](id)" on submit.
  const mentionsRef = useRef<MentionUser[]>([])
  const inputRef = useRef<HTMLInputElement>(null)

  // @mention autocomplete state.
  const [query, setQuery] = useState<string | null>(null) // null = dropdown closed
  const [results, setResults] = useState<MentionUser[]>([])
  const [activeIdx, setActiveIdx] = useState(0)
  const atStartRef = useRef<number>(-1) // index of the '@' being completed

  const size = compact ? 30 : 36

  // Detect an "@partial" token immediately left of the caret. The query runs up
  // to the first whitespace, so names with spaces are matched on their first word.
  const detectMention = (value: string, caret: number) => {
    let i = caret - 1
    while (i >= 0 && value[i] !== '@' && !/\s/.test(value[i])) i--
    if (i >= 0 && value[i] === '@' && (i === 0 || /\s/.test(value[i - 1]))) {
      atStartRef.current = i
      return value.slice(i + 1, caret)
    }
    atStartRef.current = -1
    return null
  }

  const onChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value
    setDraft(value)
    const caret = e.target.selectionStart ?? value.length
    const q = detectMention(value, caret)
    setQuery(q)
    setActiveIdx(0)
  }

  // Debounced user search while a mention is being typed.
  useEffect(() => {
    if (query == null || query.trim().length === 0) { setResults([]); return }
    const t = setTimeout(() => {
      api.get(`/users/search?q=${encodeURIComponent(query.trim())}`)
        .then(r => setResults(r.data))
        .catch(() => setResults([]))
    }, 200)
    return () => clearTimeout(t)
  }, [query])

  const pick = (u: MentionUser) => {
    const start = atStartRef.current
    if (start < 0) return
    const caret = inputRef.current?.selectionStart ?? draft.length
    const before = draft.slice(0, start)
    const after = draft.slice(caret)
    const next = `${before}@${u.displayName} ${after}`
    if (!mentionsRef.current.some(m => m.id === u.id)) mentionsRef.current.push(u)
    setDraft(next)
    setQuery(null)
    setResults([])
    // Restore focus + caret just after the inserted mention.
    requestAnimationFrame(() => {
      const pos = before.length + u.displayName.length + 2
      inputRef.current?.focus()
      inputRef.current?.setSelectionRange(pos, pos)
    })
  }

  // Serialize "@Tên" → "@[Tên](id)" for every confirmed mention still present.
  const tokenize = (text: string) => {
    let out = text
    for (const m of [...mentionsRef.current].sort((a, b) => b.displayName.length - a.displayName.length))
      out = out.split(`@${m.displayName}`).join(`@[${m.displayName}](${m.id})`)
    return out
  }

  const submit = async () => {
    const text = draft.trim()
    if (!text) return
    await onSubmit(tokenize(text))
    setDraft('')
    mentionsRef.current = []
    setQuery(null)
    setResults([])
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (query != null && results.length > 0) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setActiveIdx(i => (i + 1) % results.length); return }
      if (e.key === 'ArrowUp') { e.preventDefault(); setActiveIdx(i => (i - 1 + results.length) % results.length); return }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); pick(results[activeIdx]); return }
      if (e.key === 'Escape') { e.preventDefault(); setQuery(null); return }
    }
    if (e.key === 'Enter') submit()
  }

  const dropOpen = query != null && query.trim().length > 0 && results.length > 0

  return (
    <div style={{ flex: 1, display: 'flex', gap: compact ? 8 : 10, alignItems: 'center', position: 'relative' }}>
      {avatarUrl && <img src={avatarUrl} style={{ width: size, height: size, borderRadius: '50%', flexShrink: 0 }} />}
      <div style={{ flex: 1, position: 'relative' }}>
        <input
          ref={inputRef}
          value={draft}
          onChange={onChange}
          onKeyDown={onKeyDown}
          autoFocus={autoFocus}
          placeholder={placeholder}
          style={{ width: '100%', height: compact ? 36 : 40, borderRadius: compact ? 18 : 20, border: '1px solid var(--border)', background: 'var(--bg-elevated)', color: 'var(--text)', padding: `0 ${compact ? 14 : 16}px`, fontSize: compact ? 13 : 14, outline: 'none' }}
        />
        {dropOpen && (
          <div style={{ position: 'absolute', bottom: '100%', left: 0, marginBottom: 6, minWidth: 220, maxWidth: 300, maxHeight: 220, overflowY: 'auto', background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 10, boxShadow: 'var(--shadow-lg)', zIndex: 50 }}>
            {results.map((u, i) => (
              <button key={u.id} onMouseDown={e => { e.preventDefault(); pick(u) }} onMouseEnter={() => setActiveIdx(i)}
                style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '8px 10px', border: 'none', background: i === activeIdx ? 'var(--bg-hover)' : 'transparent', cursor: 'pointer', textAlign: 'left' }}>
                <img src={u.avatarUrl} alt="" style={{ width: 26, height: 26, borderRadius: '50%', objectFit: 'cover', flexShrink: 0 }} />
                <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{u.displayName}</span>
              </button>
            ))}
          </div>
        )}
      </div>
      <button onClick={submit} style={{ width: size, height: size, borderRadius: '50%', border: 'none', background: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--accent)', flexShrink: 0 }}>
        <span className="ms" style={{ fontSize: compact ? 20 : 22 }}>send</span>
      </button>
      {onCancel && (
        <button onClick={onCancel} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', padding: 2, flexShrink: 0 }}>
          <span className="ms" style={{ fontSize: 18 }}>close</span>
        </button>
      )}
    </div>
  )
}
