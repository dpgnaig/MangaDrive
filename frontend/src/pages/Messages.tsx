import { useEffect, useRef, useState, useCallback } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import * as signalR from '@microsoft/signalr'
import api from '../lib/api'
import AppLayout from '../components/AppLayout'
import { useAuth } from '../context/AuthContext'
import { useMessenger } from '../context/MessengerContext'
import RequestChatThread, { ReqMessage } from '../components/RequestChatThread'
import RequestMangaModal from '../components/RequestMangaModal'
import { RequestChatSkeleton, ConversationListSkeleton } from '../components/Skeleton'

interface Person { id: string; displayName: string; avatarUrl: string; role: string }
interface Conversation {
  id: string
  other: Person
  lastMessagePreview: string | null
  lastMessageAt: string
  unread: number
}

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

const LIST_PAGE_SIZE = 20

export default function Messages() {
  const { user } = useAuth()
  const { setUnread } = useMessenger()
  const navigate = useNavigate()
  const params = useParams()
  const amAdmin = user?.role === 'Admin'
  const myId = user?.id || ''

  // The active conversation is derived from the URL splat (/messages/:id).
  // A single splat route (/messages/*) keeps this component mounted when moving
  // between the list and a thread, so the one SignalR connection stays alive.
  const activeId = params['*'] || null

  const [conversations, setConversations] = useState<Conversation[]>([])
  const [loadingList, setLoadingList] = useState(true)
  const [listPage, setListPage] = useState(1)
  const [listHasMore, setListHasMore] = useState(false)
  const [loadingMoreList, setLoadingMoreList] = useState(false)
  const listSentinelRef = useRef<HTMLDivElement>(null)

  const [activeOther, setActiveOther] = useState<Person | null>(null)
  const [messages, setMessages] = useState<ReqMessage[]>([])
  const [loadingConvo, setLoadingConvo] = useState(false)
  const [sending, setSending] = useState(false)
  const [hasMoreOlder, setHasMoreOlder] = useState(false)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [otherLastReadAt, setOtherLastReadAt] = useState<string | null>(null)

  // New-chat user search. `searching` is derived: typing in the search box
  // switches the pane to user-search; clearing it returns to the list.
  const [searchQ, setSearchQ] = useState('')
  const [searchResults, setSearchResults] = useState<Person[]>([])
  const [requestOpen, setRequestOpen] = useState(false)
  const searching = searchQ.trim().length > 0

  const activeIdRef = useRef<string | null>(null)
  useEffect(() => { activeIdRef.current = activeId }, [activeId])

  const totalUnread = conversations.reduce((s, c) => s + (c.unread || 0), 0)
  useEffect(() => { setUnread(totalUnread) }, [totalUnread, setUnread])

  // (Re)load the first page of conversations.
  const loadList = useCallback(() => {
    setLoadingList(true)
    api.get(`/dm/conversations?page=1&pageSize=${LIST_PAGE_SIZE}`)
      .then(r => { setConversations(r.data.items); setListPage(1); setListHasMore(r.data.hasMore) })
      .catch(() => {})
      .finally(() => setLoadingList(false))
  }, [])

  // Append the next page (infinite scroll). Dedupe against rows already present
  // (a realtime message may have hoisted a later-page convo to the top meanwhile).
  const loadMoreList = useCallback(() => {
    setLoadingMoreList(true)
    const next = listPage + 1
    api.get(`/dm/conversations?page=${next}&pageSize=${LIST_PAGE_SIZE}`)
      .then(r => {
        setConversations(prev => {
          const seen = new Set(prev.map(c => c.id))
          return [...prev, ...r.data.items.filter((c: Conversation) => !seen.has(c.id))]
        })
        setListPage(next)
        setListHasMore(r.data.hasMore)
      })
      .catch(() => {})
      .finally(() => setLoadingMoreList(false))
  }, [listPage])

  // Load the list on mount
  useEffect(() => { loadList() }, [loadList])

  // Infinite-scroll observer for the conversation list
  useEffect(() => {
    const el = listSentinelRef.current
    if (!el || searching) return
    const observer = new IntersectionObserver(entries => {
      if (entries[0].isIntersecting && listHasMore && !loadingMoreList && !loadingList) {
        loadMoreList()
      }
    }, { threshold: 0.1 })
    observer.observe(el)
    return () => observer.disconnect()
  }, [listHasMore, loadingMoreList, loadingList, searching, loadMoreList])

  // Load the active conversation whenever the URL param changes.
  useEffect(() => {
    if (!activeId) { setActiveOther(null); setMessages([]); return }
    setLoadingConvo(true)
    api.get(`/dm/conversations/${activeId}`)
      .then(({ data }) => {
        setActiveOther(data.other)
        setMessages(data.messages)
        setHasMoreOlder(data.hasMore)
        setOtherLastReadAt(data.otherLastReadAt ?? null)
        setConversations(prev => prev.map(c => c.id === activeId ? { ...c, unread: 0 } : c))
      })
      .catch(() => {})
      .finally(() => setLoadingConvo(false))
  }, [activeId])

  // Prepend an older page of messages (infinite scroll upward).
  const loadOlder = useCallback(async () => {
    if (!activeId || loadingOlder || !hasMoreOlder) return
    const oldest = messages[0]
    if (!oldest) return
    setLoadingOlder(true)
    try {
      const { data } = await api.get(`/dm/conversations/${activeId}/messages`, { params: { before: oldest.createdAt } })
      setMessages(prev => {
        const seen = new Set(prev.map(m => m.id))
        const older = (data.messages as ReqMessage[]).filter(m => !seen.has(m.id))
        return [...older, ...prev]
      })
      setHasMoreOlder(data.hasMore)
    } catch { /* ignore */ }
    setLoadingOlder(false)
  }, [activeId, messages, hasMoreOlder, loadingOlder])

  const openConvo = (id: string) => navigate(`/messages/${id}`)
  const backToList = () => navigate('/messages')

  // One SignalR connection to /hubs/chat (server auto-joins my user group)
  useEffect(() => {
    if (!user) return
    const conn = new signalR.HubConnectionBuilder()
      .withUrl('/hubs/chat', { accessTokenFactory: () => localStorage.getItem('token') || '' })
      .withAutomaticReconnect().build()
    conn.start().catch(() => {})
    conn.on('DmMessage', (d: { conversationId: string; message: ReqMessage }) => {
      // Append if that conversation is open
      if (activeIdRef.current === d.conversationId) {
        setMessages(prev => prev.some(x => x.id === d.message.id) ? prev : [...prev, d.message])
      }
      // Update the list row (preview + unread + move to top)
      setConversations(prev => {
        const idx = prev.findIndex(c => c.id === d.conversationId)
        const isMine = d.message.senderId === myId
        const isOpen = activeIdRef.current === d.conversationId
        if (idx === -1) { loadList(); return prev }
        const row = { ...prev[idx] }
        row.lastMessagePreview = d.message.type === 'Request' ? `[Yêu cầu] ${d.message.content}` : d.message.content
        row.lastMessageAt = d.message.createdAt
        if (!isMine && !isOpen) row.unread = (row.unread || 0) + 1
        const rest = prev.filter((_, i) => i !== idx)
        return [row, ...rest]
      })
    })
    conn.on('DmMessageStatus', (d: { conversationId: string; messageId: string; status: string }) => {
      if (activeIdRef.current === d.conversationId) {
        setMessages(prev => prev.map(m => m.id === d.messageId ? { ...m, status: d.status } : m))
      }
    })
    conn.on('DmRead', (d: { conversationId: string; userId: string; readAt: string }) => {
      // The counterpart read the active conversation → advance the "seen" cursor.
      if (activeIdRef.current === d.conversationId && d.userId !== myId) setOtherLastReadAt(d.readAt)
    })
    return () => { conn.stop() }
  }, [user, myId, loadList])

  // Debounced user search
  useEffect(() => {
    if (!searching) return
    const t = setTimeout(() => {
      api.get(`/users/search?q=${encodeURIComponent(searchQ.trim())}`).then(r => setSearchResults(r.data)).catch(() => {})
    }, 300)
    return () => clearTimeout(t)
  }, [searchQ, searching])

  const send = async (content: string) => {
    if (!activeId) return
    setSending(true)
    try {
      const { data } = await api.post(`/dm/conversations/${activeId}/messages`, { content })
      setMessages(prev => prev.some(x => x.id === data.id) ? prev : [...prev, data])
    } catch { /* ignore */ }
    setSending(false)
  }

  const setStatus = async (messageId: string, status: string) => {
    try {
      await api.post(`/dm/messages/${messageId}/status`, { status })
      setMessages(prev => prev.map(m => m.id === messageId ? { ...m, status } : m))
    } catch { /* ignore */ }
  }

  const startWith = async (p: Person) => {
    try {
      const { data } = await api.post(`/dm/conversations/with/${p.id}`)
      setSearchQ(''); setSearchResults([])
      // Ensure a list row exists
      setConversations(prev => prev.some(c => c.id === data.id) ? prev : [{ id: data.id, other: data.other, lastMessagePreview: null, lastMessageAt: new Date().toISOString(), unread: 0 }, ...prev])
      openConvo(data.id)
    } catch { /* ignore */ }
  }

  const submitRequest = async (content: string) => {
    const { data } = await api.post('/dm/requests', { content })
    loadList()
    openConvo(data.conversationId)
  }

  // Counterpart of the active conversation is admin, and I'm not → allow "send request"
  const canRequestHere = !amAdmin && activeOther?.role === 'Admin'

  const listView = (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      {/* Header + always-visible search input */}
      <div style={{ paddingBottom: 12, borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
        <h2 style={{ fontSize: 15, fontWeight: 600, marginBottom: 10 }}>Tin nhắn</h2>
        <div style={{ position: 'relative' }}>
          <span className="ms ms-sm" style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)', pointerEvents: 'none' }}>search</span>
          <input value={searchQ} onChange={e => setSearchQ(e.target.value)} placeholder="Tìm người dùng theo tên..."
            style={{ width: '100%', height: 40, borderRadius: 20, border: '1px solid var(--border)', background: 'var(--bg-elevated)', color: 'var(--text)', paddingLeft: 40, paddingRight: searchQ ? 40 : 14, fontSize: 15, outline: 'none' }}
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
        <div style={{ flex: 1, overflowY: 'auto', paddingTop: 12, minHeight: 0 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {searchResults.map(p => (
              <button key={p.id} onClick={() => startWith(p)}
                style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 12px', background: 'transparent', border: 'none', borderRadius: 10, cursor: 'pointer', textAlign: 'left', width: '100%' }}
                onMouseOver={e => e.currentTarget.style.background = 'var(--bg-hover)'}
                onMouseOut={e => e.currentTarget.style.background = 'transparent'}>
                <img src={p.avatarUrl} alt="" style={{ width: 38, height: 38, borderRadius: '50%', objectFit: 'cover', flexShrink: 0 }} />
                <span style={{ fontSize: 14, fontWeight: 500, color: 'var(--text)' }}>{p.displayName}</span>
                {p.role === 'Admin' && <span style={{ fontSize: 10, fontWeight: 600, color: 'var(--accent)', marginLeft: 'auto' }}>Admin</span>}
              </button>
            ))}
            {searchQ.trim() && searchResults.length === 0 && (
              <p style={{ textAlign: 'center', color: 'var(--text-muted)', fontSize: 13, padding: '24px 0' }}>Không tìm thấy người dùng</p>
            )}
          </div>
        </div>
      ) : (
        <div style={{ flex: 1, overflowY: 'auto', paddingTop: 8, minHeight: 0 }}>
          {!amAdmin && (
            <button onClick={() => setRequestOpen(true)}
              style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '10px 12px', marginBottom: 8, borderRadius: 10, border: '1px dashed var(--accent)', background: 'transparent', color: 'var(--accent)', fontSize: 13, fontWeight: 500, cursor: 'pointer' }}>
              <span className="ms" style={{ fontSize: 18 }}>library_add</span> Tạo yêu cầu manga
            </button>
          )}
          {loadingList ? <ConversationListSkeleton /> : conversations.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '40px 20px', color: 'var(--text-muted)' }}>
              <span className="ms" style={{ fontSize: 40, display: 'block', marginBottom: 8 }}>forum</span>
              <p style={{ fontSize: 13 }}>Chưa có cuộc trò chuyện nào</p>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {conversations.map(c => {
                const isActive = c.id === activeId
                return (
                  <button key={c.id} onClick={() => openConvo(c.id)}
                    style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 12px', background: isActive ? 'var(--accent-subtle)' : 'transparent', borderRadius: 10, border: 'none', cursor: 'pointer', textAlign: 'left', width: '100%' }}
                    onMouseOver={e => { if (!isActive) e.currentTarget.style.background = 'var(--bg-hover)' }}
                    onMouseOut={e => { if (!isActive) e.currentTarget.style.background = 'transparent' }}>
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
                )
              })}
              {/* Infinite-scroll sentinel + loading indicator */}
              <div ref={listSentinelRef} style={{ height: 1 }} />
              {loadingMoreList && (
                <div style={{ textAlign: 'center', padding: 12 }}>
                  <span className="ms spin" style={{ fontSize: 20, color: 'var(--accent)' }}>progress_activity</span>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )

  const threadView = activeOther && (
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
      header={
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, paddingBottom: 12, borderBottom: '1px solid var(--border)' }}>
          <button onClick={backToList} className="icon-btn icon-btn-sm req-back-btn" style={{ flexShrink: 0 }}>
            <span className="ms">arrow_back</span>
          </button>
          <img src={activeOther.avatarUrl} alt="" style={{ width: 36, height: 36, borderRadius: '50%', objectFit: 'cover', flexShrink: 0 }} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <p style={{ fontSize: 14, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{activeOther.displayName}</p>
            {activeOther.role === 'Admin' && <p style={{ fontSize: 11, color: 'var(--accent)' }}>Admin</p>}
          </div>
        </div>
      }
    />
  )

  return (
    <AppLayout showTopNav={false} showSearch={false} showBottomNav={false} showSider={false} noPadding>
      <div className="messages-page">
        <div className="req-admin-layout" style={{ height: '100%', minHeight: 0, padding: 16 }}>
          <div className={`req-admin-list ${activeId ? 'has-active' : ''}`} style={{ height: '100%' }}>{listView}</div>
          <div className={`req-admin-thread ${activeId ? 'has-active' : ''}`} style={{ height: '100%' }}>
            {loadingConvo ? <RequestChatSkeleton /> : activeId ? threadView : (
              <div style={{ height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)' }}>
                <span className="ms" style={{ fontSize: 44, marginBottom: 10 }}>chat</span>
                <p style={{ fontSize: 13 }}>Chọn một cuộc trò chuyện</p>
              </div>
            )}
          </div>
        </div>
      </div>
      <RequestMangaModal open={requestOpen} onClose={() => setRequestOpen(false)} onSubmit={submitRequest} />
    </AppLayout>
  )
}
