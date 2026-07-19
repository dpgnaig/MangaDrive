import { createContext, useContext, useState, useEffect, useRef, useCallback } from 'react'
import * as signalR from '@microsoft/signalr'
import { useAuth } from './AuthContext'
import api from '../lib/api'
import type { ReqMessage } from '../components/RequestChatThread'

export interface Person { id: string; displayName: string; avatarUrl: string; role: string }
export interface Conversation {
  id: string
  other: Person
  lastMessagePreview: string | null
  lastMessageAt: string
  unread: number
}
export interface DmWindow { id: string; other: Person; minimized: boolean }

export interface DmMessageEvt { conversationId: string; message: ReqMessage }
export interface DmStatusEvt { conversationId: string; messageId: string; status: string }
export interface DmReadEvt { conversationId: string; userId: string; readAt: string }

interface MessengerCtx {
  /** Total unread across all conversations (drives the TopNav badge). */
  unread: number
  setUnread: (v: number) => void

  /** Shared conversation list (used by the desktop popover). */
  conversations: Conversation[]
  loadingList: boolean
  hasMore: boolean
  loadingMore: boolean
  loadList: () => void
  loadMore: () => void

  /** Desktop popover (conversation list dropdown) open state. */
  panelOpen: boolean
  setPanelOpen: (v: boolean) => void

  /** Desktop docked chat windows. */
  windows: DmWindow[]
  openChat: (id: string, other: Person) => void
  closeChat: (id: string) => void
  toggleMinimize: (id: string) => void

  /** Subscribe to realtime events from the single shared connection. */
  subscribeMessage: (cb: (e: DmMessageEvt) => void) => () => void
  subscribeStatus: (cb: (e: DmStatusEvt) => void) => () => void
  subscribeRead: (cb: (e: DmReadEvt) => void) => () => void

  /** Locally clear a conversation's unread (e.g. after opening it). */
  markConversationRead: (id: string) => void
}

const Ctx = createContext<MessengerCtx>({} as MessengerCtx)
export const useMessenger = () => useContext(Ctx)

const LIST_PAGE_SIZE = 20
const MAX_WINDOWS = 3

export function MessengerProvider({ children }: { children: React.ReactNode }) {
  const { user } = useAuth()
  const myId = user?.id || ''

  const [unread, setUnread] = useState(0)
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [loadingList, setLoadingList] = useState(false)
  const [listPage, setListPage] = useState(1)
  const [hasMore, setHasMore] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [panelOpen, setPanelOpen] = useState(false)
  const [windows, setWindows] = useState<DmWindow[]>([])

  // Listener registries for the single shared connection.
  const msgListeners = useRef(new Set<(e: DmMessageEvt) => void>())
  const statusListeners = useRef(new Set<(e: DmStatusEvt) => void>())
  const readListeners = useRef(new Set<(e: DmReadEvt) => void>())

  const subscribeMessage = useCallback((cb: (e: DmMessageEvt) => void) => {
    msgListeners.current.add(cb)
    return () => { msgListeners.current.delete(cb) }
  }, [])
  const subscribeStatus = useCallback((cb: (e: DmStatusEvt) => void) => {
    statusListeners.current.add(cb)
    return () => { statusListeners.current.delete(cb) }
  }, [])
  const subscribeRead = useCallback((cb: (e: DmReadEvt) => void) => {
    readListeners.current.add(cb)
    return () => { readListeners.current.delete(cb) }
  }, [])

  const loadList = useCallback(() => {
    setLoadingList(true)
    api.get(`/dm/conversations?page=1&pageSize=${LIST_PAGE_SIZE}`)
      .then(r => { setConversations(r.data.items); setListPage(1); setHasMore(r.data.hasMore) })
      .catch(() => {})
      .finally(() => setLoadingList(false))
  }, [])

  const loadMore = useCallback(() => {
    if (loadingMore || !hasMore) return
    setLoadingMore(true)
    const next = listPage + 1
    api.get(`/dm/conversations?page=${next}&pageSize=${LIST_PAGE_SIZE}`)
      .then(r => {
        setConversations(prev => {
          const seen = new Set(prev.map(c => c.id))
          return [...prev, ...r.data.items.filter((c: Conversation) => !seen.has(c.id))]
        })
        setListPage(next)
        setHasMore(r.data.hasMore)
      })
      .catch(() => {})
      .finally(() => setLoadingMore(false))
  }, [listPage, hasMore, loadingMore])

  const markConversationRead = useCallback((id: string) => {
    setConversations(prev => prev.map(c => c.id === id ? { ...c, unread: 0 } : c))
  }, [])

  const openChat = useCallback((id: string, other: Person) => {
    setWindows(prev => {
      const existing = prev.find(w => w.id === id)
      if (existing) return prev.map(w => w.id === id ? { ...w, minimized: false } : w)
      const next = [{ id, other, minimized: false }, ...prev]
      return next.slice(0, MAX_WINDOWS)
    })
    markConversationRead(id)
    setPanelOpen(false)
  }, [markConversationRead])

  const closeChat = useCallback((id: string) => {
    setWindows(prev => prev.filter(w => w.id !== id))
  }, [])

  const toggleMinimize = useCallback((id: string) => {
    setWindows(prev => prev.map(w => w.id === id ? { ...w, minimized: !w.minimized } : w))
  }, [])

  // Poll the authoritative unread count so the badge stays fresh app-wide.
  useEffect(() => {
    if (!user) { setUnread(0); return }
    const fetch = () => { api.get('/dm/unread-count').then(r => setUnread(r.data)).catch(() => {}) }
    fetch()
    const interval = setInterval(fetch, 30000)
    return () => clearInterval(interval)
  }, [user])

  // Reset transient state on logout.
  useEffect(() => {
    if (!user) {
      setConversations([]); setWindows([]); setPanelOpen(false)
    }
  }, [user])

  // Single shared SignalR connection: fan every event out to subscribers and
  // keep the conversation list + badge in sync.
  useEffect(() => {
    if (!user) return
    const conn = new signalR.HubConnectionBuilder()
      .withUrl('/hubs/chat', { accessTokenFactory: () => localStorage.getItem('token') || '' })
      .withAutomaticReconnect().build()
    conn.start().catch(() => {})

    conn.on('DmMessage', (d: DmMessageEvt) => {
      msgListeners.current.forEach(cb => cb(d))
      const isMine = d.message.senderId === myId
      // Refresh authoritative badge for anything from others.
      if (!isMine) api.get('/dm/unread-count').then(r => setUnread(r.data)).catch(() => {})
      // Update the list row (preview + unread + hoist to top).
      setConversations(prev => {
        const idx = prev.findIndex(c => c.id === d.conversationId)
        if (idx === -1) return prev
        const row = { ...prev[idx] }
        row.lastMessagePreview = d.message.type === 'Request' ? `[Yêu cầu] ${d.message.content}` : d.message.content
        row.lastMessageAt = d.message.createdAt
        // Only bump the row's unread when the window for it isn't open.
        setWindows(ws => {
          const open = ws.some(w => w.id === d.conversationId && !w.minimized)
          if (!isMine && !open) row.unread = (row.unread || 0) + 1
          return ws
        })
        const rest = prev.filter((_, i) => i !== idx)
        return [row, ...rest]
      })
    })

    conn.on('DmMessageStatus', (d: DmStatusEvt) => {
      statusListeners.current.forEach(cb => cb(d))
    })

    conn.on('DmRead', (d: DmReadEvt) => {
      readListeners.current.forEach(cb => cb(d))
    })

    return () => { conn.stop() }
  }, [user, myId])

  return (
    <Ctx.Provider value={{
      unread, setUnread,
      conversations, loadingList, hasMore, loadingMore, loadList, loadMore,
      panelOpen, setPanelOpen,
      windows, openChat, closeChat, toggleMinimize,
      subscribeMessage, subscribeStatus, subscribeRead, markConversationRead,
    }}>
      {children}
    </Ctx.Provider>
  )
}
