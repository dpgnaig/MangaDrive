import { useEffect, useRef, useState } from 'react'

export interface ReqMessage { id: string; senderId: string; type: string; content: string; createdAt: string; status?: string | null }

export function statusMeta(status: string) {
  switch (status) {
    case 'Approved': return { label: 'Đã duyệt', color: 'var(--green)', bg: 'rgba(52,199,89,0.15)', icon: 'check_circle' }
    case 'Rejected': return { label: 'Từ chối', color: 'var(--red)', bg: 'rgba(255,59,48,0.15)', icon: 'cancel' }
    default: return { label: 'Đang chờ', color: 'var(--text-muted)', bg: 'var(--bg-hover)', icon: 'schedule' }
  }
}

function fmtTime(d: string) {
  return new Date(d).toLocaleString('vi', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' })
}

interface Props {
  messages: ReqMessage[]
  currentUserId: string
  /** Whether the current viewer is an admin (can approve/reject request cards). */
  amAdmin?: boolean
  onSend: (content: string) => Promise<void> | void
  sending?: boolean
  /** Rendered above the message list (conversation header). */
  header?: React.ReactNode
  emptyHint?: string
  placeholder?: string
  /** Admin only: set the status label on a request message. */
  onSetStatus?: (messageId: string, status: string) => void
  /** Extra control rendered left of the composer input (e.g. "create request"). */
  composerAccessory?: React.ReactNode
  /** Load older messages (prepended). Should resolve after state updates. */
  onLoadOlder?: () => Promise<void> | void
  /** Whether more older messages exist above the current top. */
  hasMoreOlder?: boolean
  /** Whether an older-messages page is currently loading. */
  loadingOlder?: boolean
  /** ISO time the counterpart last read this conversation. My messages with
   *  createdAt <= this are marked "seen". */
  otherLastReadAt?: string | null
}

export default function RequestChatThread({ messages, currentUserId, amAdmin, onSend, sending, header, emptyHint, placeholder, onSetStatus, composerAccessory, onLoadOlder, hasMoreOlder, loadingOlder, otherLastReadAt }: Props) {
  const [draft, setDraft] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)
  // scrollHeight snapshot captured just before an older-messages load, so we can
  // restore the viewport after the prepend instead of jumping.
  const restoreRef = useRef<number | null>(null)
  const loadingOlderRef = useRef(false)
  const prevFirstIdRef = useRef<string | null>(null)
  const prevLastIdRef = useRef<string | null>(null)

  // Keep the viewport anchored: restore position after an older-message prepend,
  // otherwise scroll to the newest message on append / initial load.
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const firstId = messages[0]?.id ?? null
    const lastId = messages[messages.length - 1]?.id ?? null
    const prepended = restoreRef.current != null && firstId !== prevFirstIdRef.current
    if (prepended) {
      el.scrollTop = el.scrollHeight - (restoreRef.current as number)
      restoreRef.current = null
    } else if (lastId !== prevLastIdRef.current) {
      el.scrollTop = el.scrollHeight
    }
    prevFirstIdRef.current = firstId
    prevLastIdRef.current = lastId
  }, [messages])

  // Index of my last outgoing message the counterpart has already read
  // (createdAt <= otherLastReadAt). Used to render a single "Đã xem" marker.
  const lastSeenMineIdx = (() => {
    if (!otherLastReadAt) return -1
    const readMs = new Date(otherLastReadAt).getTime()
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]
      if (m.senderId !== currentUserId) continue
      if (new Date(m.createdAt).getTime() <= readMs) return i
      return -1 // my newest message is not yet read
    }
    return -1
  })()

  const handleScroll = async () => {
    const el = scrollRef.current
    if (!el || !onLoadOlder || !hasMoreOlder || loadingOlderRef.current) return
    if (el.scrollTop < 60) {
      loadingOlderRef.current = true
      restoreRef.current = el.scrollHeight
      try { await onLoadOlder() } finally { loadingOlderRef.current = false }
    }
  }

  const submit = async () => {
    const c = draft.trim()
    if (!c || sending) return
    setDraft('')
    await onSend(c)
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      {header}

      {/* Messages */}
      <div ref={scrollRef} onScroll={handleScroll} style={{ flex: 1, overflowY: 'auto', padding: '16px 4px', display: 'flex', flexDirection: 'column', gap: 10, minHeight: 0 }}>
        {loadingOlder && (
          <div style={{ textAlign: 'center', padding: '4px 0 8px' }}>
            <span className="ms spin" style={{ fontSize: 18, color: 'var(--accent)' }}>progress_activity</span>
          </div>
        )}
        {messages.length === 0 && (
          <div style={{ margin: 'auto', textAlign: 'center', color: 'var(--text-muted)', padding: '40px 20px' }}>
            <span className="ms" style={{ fontSize: 40, display: 'block', marginBottom: 10 }}>forum</span>
            <p style={{ fontSize: 13 }}>{emptyHint || 'Chưa có tin nhắn nào'}</p>
          </div>
        )}
        {messages.map((m, idx) => {
          const mine = m.senderId === currentUserId
          const isRequest = m.type === 'Request'
          const sm = isRequest && m.status ? statusMeta(m.status) : null
          // "Seen" is shown only on my newest message, once the counterpart's
          // read cursor has advanced past it.
          const isMyLast = mine && idx === messages.length - 1
          const seen = isMyLast && otherLastReadAt != null &&
            new Date(otherLastReadAt).getTime() >= new Date(m.createdAt).getTime()
          return (
            <div key={m.id} style={{ display: 'flex', flexDirection: 'column', alignItems: mine ? 'flex-end' : 'flex-start' }}>
              {isRequest ? (
                /* Request card */
                <div style={{
                  maxWidth: '82%', padding: '10px 13px', borderRadius: 14,
                  background: 'var(--bg-elevated)', border: '1px solid var(--accent)',
                  borderBottomRightRadius: mine ? 4 : 14, borderBottomLeftRadius: mine ? 14 : 4,
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6, color: 'var(--accent)' }}>
                    <span className="ms" style={{ fontSize: 16 }}>library_add</span>
                    <span style={{ fontSize: 12, fontWeight: 600 }}>Yêu cầu manga</span>
                  </div>
                  <div style={{ fontSize: 14, lineHeight: 1.45, whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: 'var(--text)' }}>{m.content}</div>
                  {sm && (
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, fontWeight: 500, padding: '2px 9px', borderRadius: 10, background: sm.bg, color: sm.color, marginTop: 8 }}>
                      <span className="ms" style={{ fontSize: 13 }}>{sm.icon}</span>{sm.label}
                    </span>
                  )}
                </div>
              ) : (
                /* Text bubble */
                <div style={{
                  maxWidth: '78%', padding: '9px 13px', borderRadius: 14,
                  background: mine ? 'var(--accent)' : 'var(--bg-elevated)',
                  color: mine ? '#fff' : 'var(--text)',
                  border: mine ? 'none' : '1px solid var(--border)',
                  borderBottomRightRadius: mine ? 4 : 14,
                  borderBottomLeftRadius: mine ? 14 : 4,
                  fontSize: 14, lineHeight: 1.45, whiteSpace: 'pre-wrap', wordBreak: 'break-word'
                }}>
                  {m.content}
                </div>
              )}

              {/* Admin: per-request status action buttons */}
              {isRequest && amAdmin && onSetStatus && (
                <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', margin: '5px 4px 0' }}>
                  {[
                    { key: 'Approved', label: 'Duyệt', icon: 'check_circle', color: 'var(--green)' },
                    { key: 'Rejected', label: 'Từ chối', icon: 'cancel', color: 'var(--red)' },
                    { key: 'Open', label: 'Mở lại', icon: 'schedule', color: 'var(--text-secondary)' },
                  ].filter(b => b.key !== m.status).map(b => (
                    <button key={b.key} onClick={() => onSetStatus(m.id, b.key)}
                      style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '4px 10px', borderRadius: 14, border: '1px solid var(--border)', background: 'transparent', color: b.color, fontSize: 11, fontWeight: 500, cursor: 'pointer' }}>
                      <span className="ms" style={{ fontSize: 13 }}>{b.icon}</span>{b.label}
                    </button>
                  ))}
                </div>
              )}

              <span style={{ fontSize: 10, color: 'var(--text-muted)', margin: '3px 4px 0', display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                {fmtTime(m.createdAt)}
                {isMyLast && (
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 2, color: seen ? 'var(--accent)' : 'var(--text-muted)' }}>
                    <span className="ms" style={{ fontSize: 13 }}>{seen ? 'done_all' : 'done'}</span>
                    {seen ? 'Đã xem' : 'Đã gửi'}
                  </span>
                )}
              </span>
            </div>
          )
        })}
      </div>

      {/* Composer */}
      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', padding: '10px 4px 4px', borderTop: '1px solid var(--border)' }}>
        {composerAccessory}
        <textarea
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit() } }}
          placeholder={placeholder || 'Nhập tin nhắn...'}
          rows={1}
          style={{
            flex: 1, resize: 'none', maxHeight: 120, padding: '10px 14px', borderRadius: 20,
            border: '1px solid var(--border)', background: 'var(--bg-elevated)', color: 'var(--text)',
            fontSize: 14, outline: 'none', fontFamily: 'inherit', lineHeight: 1.4
          }}
          onFocus={e => e.currentTarget.style.borderColor = 'var(--accent)'}
          onBlur={e => e.currentTarget.style.borderColor = 'var(--border)'}
        />
        <button onClick={submit} disabled={!draft.trim() || sending}
          style={{
            width: 40, height: 40, flexShrink: 0, borderRadius: '50%', border: 'none',
            background: (!draft.trim() || sending) ? 'var(--bg-hover)' : 'var(--accent)',
            color: (!draft.trim() || sending) ? 'var(--text-muted)' : '#fff',
            cursor: (!draft.trim() || sending) ? 'default' : 'pointer',
            display: 'flex', alignItems: 'center', justifyContent: 'center'
          }}>
          <span className={`ms ${sending ? 'spin' : ''}`} style={{ fontSize: 20 }}>{sending ? 'progress_activity' : 'send'}</span>
        </button>
      </div>
    </div>
  )
}
