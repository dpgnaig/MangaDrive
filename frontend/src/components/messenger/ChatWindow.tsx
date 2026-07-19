import { useEffect, useState, useCallback } from 'react'
import api from '../../lib/api'
import { useAuth } from '../../context/AuthContext'
import { useMessenger, DmWindow } from '../../context/MessengerContext'
import RequestChatThread, { ReqMessage } from '../RequestChatThread'
import RequestMangaModal from '../RequestMangaModal'
import { RequestChatSkeleton } from '../Skeleton'

/** One docked desktop chat window (bottom of screen). */
export default function ChatWindow({ win, offset }: { win: DmWindow; offset: number }) {
  const { user } = useAuth()
  const { subscribeMessage, subscribeStatus, subscribeRead, closeChat, toggleMinimize, markConversationRead } = useMessenger()
  const myId = user?.id || ''
  const amAdmin = user?.role === 'Admin'

  const [messages, setMessages] = useState<ReqMessage[]>([])
  const [loading, setLoading] = useState(true)
  const [sending, setSending] = useState(false)
  const [hasMoreOlder, setHasMoreOlder] = useState(false)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [requestOpen, setRequestOpen] = useState(false)
  const [otherLastReadAt, setOtherLastReadAt] = useState<string | null>(null)

  // Load the conversation (also resets my unread server-side).
  useEffect(() => {
    setLoading(true)
    api.get(`/dm/conversations/${win.id}`)
      .then(({ data }) => { setMessages(data.messages); setHasMoreOlder(data.hasMore); setOtherLastReadAt(data.otherLastReadAt ?? null); markConversationRead(win.id) })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [win.id, markConversationRead])

  // Prepend an older page (infinite scroll upward).
  const loadOlder = useCallback(async () => {
    if (loadingOlder || !hasMoreOlder) return
    const oldest = messages[0]
    if (!oldest) return
    setLoadingOlder(true)
    try {
      const { data } = await api.get(`/dm/conversations/${win.id}/messages`, { params: { before: oldest.createdAt } })
      setMessages(prev => {
        const seen = new Set(prev.map(m => m.id))
        const older = (data.messages as ReqMessage[]).filter(m => !seen.has(m.id))
        return [...older, ...prev]
      })
      setHasMoreOlder(data.hasMore)
    } catch { /* ignore */ }
    setLoadingOlder(false)
  }, [win.id, messages, hasMoreOlder, loadingOlder])

  // Realtime append for this conversation.
  useEffect(() => subscribeMessage(e => {
    if (e.conversationId !== win.id) return
    setMessages(prev => prev.some(x => x.id === e.message.id) ? prev : [...prev, e.message])
    // Keep it read while the window is open and expanded.
    if (!win.minimized) { markConversationRead(win.id); api.get(`/dm/conversations/${win.id}`).catch(() => {}) }
  }), [win.id, win.minimized, subscribeMessage, markConversationRead])

  useEffect(() => subscribeStatus(e => {
    if (e.conversationId !== win.id) return
    setMessages(prev => prev.map(m => m.id === e.messageId ? { ...m, status: e.status } : m))
  }), [win.id, subscribeStatus])

  // Counterpart read my messages → advance their read cursor for "seen".
  useEffect(() => subscribeRead(e => {
    if (e.conversationId !== win.id || e.userId === myId) return
    setOtherLastReadAt(e.readAt)
  }), [win.id, myId, subscribeRead])

  // The counterpart read the conversation → advance their read cursor for "seen".
  useEffect(() => subscribeRead(e => {
    if (e.conversationId !== win.id || e.userId === myId) return
    setOtherLastReadAt(prev => !prev || new Date(e.readAt) > new Date(prev) ? e.readAt : prev)
  }), [win.id, myId, subscribeRead])

  // The counterpart read my messages → advance their read cursor for "seen".
  useEffect(() => subscribeRead(e => {
    if (e.conversationId !== win.id || e.userId === myId) return
    setOtherLastReadAt(e.readAt)
  }), [win.id, myId, subscribeRead])

  const send = useCallback(async (content: string) => {
    setSending(true)
    try {
      const { data } = await api.post(`/dm/conversations/${win.id}/messages`, { content })
      setMessages(prev => prev.some(x => x.id === data.id) ? prev : [...prev, data])
    } catch { /* ignore */ }
    setSending(false)
  }, [win.id])

  const setStatus = useCallback(async (messageId: string, status: string) => {
    try {
      await api.post(`/dm/messages/${messageId}/status`, { status })
      setMessages(prev => prev.map(m => m.id === messageId ? { ...m, status } : m))
    } catch { /* ignore */ }
  }, [])

  const submitRequest = useCallback(async (content: string) => {
    await api.post('/dm/requests', { content })
  }, [])

  const canRequestHere = !amAdmin && win.other.role === 'Admin'

  return (
    <div className="dm-window" style={{ right: offset }}>
      {/* Header */}
      <div className="dm-window-head" onClick={() => toggleMinimize(win.id)}>
        <img src={win.other.avatarUrl} alt="" style={{ width: 30, height: 30, borderRadius: '50%', objectFit: 'cover', flexShrink: 0 }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <p style={{ fontSize: 13, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{win.other.displayName}</p>
          {win.other.role === 'Admin' && <p style={{ fontSize: 10, color: 'var(--accent)', lineHeight: 1 }}>Admin</p>}
        </div>
        <button className="icon-btn icon-btn-sm" onClick={e => { e.stopPropagation(); toggleMinimize(win.id) }} title={win.minimized ? 'Mở' : 'Thu nhỏ'} style={{ color: 'var(--text-secondary)' }}>
          <span className="ms" style={{ fontSize: 18 }}>{win.minimized ? 'expand_less' : 'remove'}</span>
        </button>
        <button className="icon-btn icon-btn-sm" onClick={e => { e.stopPropagation(); closeChat(win.id) }} title="Đóng" style={{ color: 'var(--text-secondary)' }}>
          <span className="ms" style={{ fontSize: 18 }}>close</span>
        </button>
      </div>

      {/* Body (hidden when minimized) */}
      {!win.minimized && (
        <div className="dm-window-body">
          {loading ? <RequestChatSkeleton /> : (
            <RequestChatThread
              messages={messages}
              currentUserId={myId}
              amAdmin={amAdmin}
              onSend={send}
              sending={sending}
              onSetStatus={setStatus}
              onLoadOlder={loadOlder}
              hasMoreOlder={hasMoreOlder}
              loadingOlder={loadingOlder}
              otherLastReadAt={otherLastReadAt}
              placeholder="Nhập tin nhắn..."
              composerAccessory={canRequestHere ? (
                <button onClick={() => setRequestOpen(true)} title="Gửi yêu cầu manga"
                  style={{ width: 40, height: 40, flexShrink: 0, borderRadius: '50%', border: '1px solid var(--border)', background: 'transparent', color: 'var(--accent)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <span className="ms" style={{ fontSize: 20 }}>library_add</span>
                </button>
              ) : undefined}
            />
          )}
        </div>
      )}
      <RequestMangaModal open={requestOpen} onClose={() => setRequestOpen(false)} onSubmit={submitRequest} />
    </div>
  )
}
