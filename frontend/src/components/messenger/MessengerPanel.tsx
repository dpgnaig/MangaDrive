import { useEffect, useRef, useState } from 'react'
import api from '../../lib/api'
import { useAuth } from '../../context/AuthContext'
import { useMessenger, Person } from '../../context/MessengerContext'
import { ConversationListSkeleton } from '../Skeleton'
import RequestMangaModal from '../RequestMangaModal'

function timeAgo(dateStr: string) {
  const diff = Date.now() - new Date(dateStr).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'Vừa xong'
  if (mins < 60) return `${mins} phút`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours} giờ`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days} ngày`
  return new Date(dateStr).toLocaleDateString('vi')
}

/** Desktop dropdown listing conversations, anchored below the TopNav messenger icon. */
export default function MessengerPanel({ anchorRef }: { anchorRef: React.RefObject<HTMLElement | null> }) {
  const { user } = useAuth()
  const amAdmin = user?.role === 'Admin'
  const {
    conversations, loadingList, hasMore, loadingMore, loadList, loadMore,
    setPanelOpen, openChat,
  } = useMessenger()

  const panelRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const [searchQ, setSearchQ] = useState('')
  const [searchResults, setSearchResults] = useState<Person[]>([])
  const [requestOpen, setRequestOpen] = useState(false)
  const searching = searchQ.trim().length > 0

  // Load the list each time the panel opens.
  useEffect(() => { loadList() }, [loadList])

  // Close on outside click (ignore clicks on the anchor button — it toggles).
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node
      if (panelRef.current?.contains(t)) return
      if (anchorRef.current?.contains(t)) return
      setPanelOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [anchorRef, setPanelOpen])

  // Debounced user search.
  useEffect(() => {
    if (!searching) return
    const t = setTimeout(() => {
      api.get(`/users/search?q=${encodeURIComponent(searchQ.trim())}`).then(r => setSearchResults(r.data)).catch(() => {})
    }, 300)
    return () => clearTimeout(t)
  }, [searchQ, searching])

  const handleScroll = () => {
    const el = listRef.current
    if (!el || searching) return
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 80 && hasMore && !loadingMore) loadMore()
  }

  const startWith = async (p: Person) => {
    try {
      const { data } = await api.post(`/dm/conversations/with/${p.id}`)
      setSearchQ(''); setSearchResults([])
      openChat(data.id, data.other)
    } catch { /* ignore */ }
  }

  const submitRequest = async (content: string) => {
    const { data } = await api.post('/dm/requests', { content })
    loadList()
    // We only get conversationId back; open with a minimal admin placeholder,
    // ChatWindow fetches the real header data on mount via the conversation.
    const convo = await api.get(`/dm/conversations/${data.conversationId}`)
    openChat(data.conversationId, convo.data.other)
  }

  return (
    <div ref={panelRef} className="dm-panel">
      {/* Header + always-visible search input */}
      <div style={{ padding: '12px 12px 10px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 10 }}>
          <span style={{ fontSize: 15, fontWeight: 600 }}>Tin nhắn</span>
        </div>
        <div style={{ position: 'relative' }}>
          <span className="ms ms-sm" style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)', pointerEvents: 'none' }}>search</span>
          <input value={searchQ} onChange={e => setSearchQ(e.target.value)} placeholder="Tìm người dùng theo tên..."
            style={{ width: '100%', height: 38, borderRadius: 19, border: '1px solid var(--border)', background: 'var(--bg-elevated)', color: 'var(--text)', paddingLeft: 38, paddingRight: searchQ ? 38 : 14, fontSize: 14, outline: 'none' }}
            onFocus={e => e.currentTarget.style.borderColor = 'var(--accent)'}
            onBlur={e => e.currentTarget.style.borderColor = 'var(--border)'} />
          {searchQ && (
            <button onClick={() => { setSearchQ(''); setSearchResults([]) }}
              style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', display: 'flex', padding: 2 }}>
              <span className="ms" style={{ fontSize: 18 }}>close</span>
            </button>
          )}
        </div>
      </div>

      {searching ? (
        <div style={{ flex: 1, overflowY: 'auto', padding: 8, minHeight: 0 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {searchResults.map(p => (
              <button key={p.id} onClick={() => startWith(p)}
                style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '8px 10px', background: 'transparent', border: 'none', borderRadius: 10, cursor: 'pointer', textAlign: 'left', width: '100%' }}
                onMouseOver={e => e.currentTarget.style.background = 'var(--bg-hover)'}
                onMouseOut={e => e.currentTarget.style.background = 'transparent'}>
                <img src={p.avatarUrl} alt="" style={{ width: 36, height: 36, borderRadius: '50%', objectFit: 'cover', flexShrink: 0 }} />
                <span style={{ fontSize: 14, fontWeight: 500, color: 'var(--text)' }}>{p.displayName}</span>
                {p.role === 'Admin' && <span style={{ fontSize: 10, fontWeight: 600, color: 'var(--accent)', marginLeft: 'auto' }}>Admin</span>}
              </button>
            ))}
            {searchResults.length === 0 && (
              <p style={{ textAlign: 'center', color: 'var(--text-muted)', fontSize: 13, padding: '24px 0' }}>Không tìm thấy người dùng</p>
            )}
          </div>
        </div>
      ) : (
        <div ref={listRef} onScroll={handleScroll} style={{ flex: 1, overflowY: 'auto', padding: 8, minHeight: 0 }}>
          {!amAdmin && (
            <button onClick={() => setRequestOpen(true)}
              style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '10px 12px', marginBottom: 8, borderRadius: 10, border: '1px dashed var(--accent)', background: 'transparent', color: 'var(--accent)', fontSize: 13, fontWeight: 500, cursor: 'pointer' }}>
              <span className="ms" style={{ fontSize: 18 }}>library_add</span> Tạo yêu cầu manga
            </button>
          )}
          {loadingList && conversations.length === 0 ? <ConversationListSkeleton /> : conversations.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '40px 20px', color: 'var(--text-muted)' }}>
              <span className="ms" style={{ fontSize: 40, display: 'block', marginBottom: 8 }}>forum</span>
              <p style={{ fontSize: 13 }}>Chưa có cuộc trò chuyện nào</p>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              {conversations.map(c => (
                <button key={c.id} onClick={() => openChat(c.id, c.other)}
                  style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '8px 10px', background: 'transparent', borderRadius: 10, border: 'none', cursor: 'pointer', textAlign: 'left', width: '100%' }}
                  onMouseOver={e => e.currentTarget.style.background = 'var(--bg-hover)'}
                  onMouseOut={e => e.currentTarget.style.background = 'transparent'}>
                  <img src={c.other.avatarUrl} alt="" style={{ width: 44, height: 44, borderRadius: '50%', objectFit: 'cover', flexShrink: 0 }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <p style={{ fontSize: 14, fontWeight: c.unread > 0 ? 700 : 600, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1, minWidth: 0 }}>{c.other.displayName}</p>
                      {c.other.role === 'Admin' && <span style={{ fontSize: 10, fontWeight: 600, color: 'var(--accent)', flexShrink: 0 }}>Admin</span>}
                    </div>
                    <p style={{ fontSize: 12, color: c.unread > 0 ? 'var(--text)' : 'var(--text-muted)', fontWeight: c.unread > 0 ? 600 : 400, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginTop: 2 }}>
                      {c.lastMessagePreview || 'Bắt đầu trò chuyện'}
                    </p>
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4, flexShrink: 0 }}>
                    <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>{timeAgo(c.lastMessageAt)}</span>
                    {c.unread > 0 && (
                      <span style={{ minWidth: 18, height: 18, padding: '0 5px', borderRadius: 9, background: 'var(--accent)', color: '#fff', fontSize: 10, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                        {c.unread}
                      </span>
                    )}
                  </div>
                </button>
              ))}
              {loadingMore && (
                <div style={{ textAlign: 'center', padding: 12 }}>
                  <span className="ms spin" style={{ fontSize: 20, color: 'var(--accent)' }}>progress_activity</span>
                </div>
              )}
            </div>
          )}
        </div>
      )}
      <RequestMangaModal open={requestOpen} onClose={() => setRequestOpen(false)} onSubmit={submitRequest} />
    </div>
  )
}
