import { useState, useEffect, useRef } from 'react'
import { Badge } from 'antd'
import { useNavigate } from 'react-router-dom'
import api from '../lib/api'

interface Notification {
  id: string
  type: string
  title: string
  message: string
  link: string | null
  isRead: boolean
  createdAt: string
}

const PAGE_SIZE = 20

export default function NotificationBell() {
  const [notifications, setNotifications] = useState<Notification[]>([])
  const [unreadCount, setUnreadCount] = useState(0)
  const [open, setOpen] = useState(false)
  const [hasMore, setHasMore] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const loadingRef = useRef(false)
  const navigate = useNavigate()

  useEffect(() => {
    fetchUnreadCount()
    const interval = setInterval(fetchUnreadCount, 30000)
    return () => clearInterval(interval)
  }, [])

  useEffect(() => { if (open) fetchNotifications() }, [open])

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  const fetchUnreadCount = () => { api.get('/notifications/unread-count').then(r => setUnreadCount(r.data)).catch(() => {}) }

  const fetchNotifications = () => {
    api.get(`/notifications?skip=0&take=${PAGE_SIZE}`).then(r => {
      setNotifications(r.data)
      setHasMore(r.data.length === PAGE_SIZE)
    }).catch(() => {})
  }

  const loadMore = async () => {
    if (loadingRef.current || !hasMore) return
    loadingRef.current = true
    setLoadingMore(true)
    try {
      const { data } = await api.get(`/notifications?skip=${notifications.length}&take=${PAGE_SIZE}`)
      setNotifications(prev => [...prev, ...data])
      setHasMore(data.length === PAGE_SIZE)
    } catch { /* ignore */ }
    setLoadingMore(false)
    loadingRef.current = false
  }

  const handleScroll = () => {
    const el = listRef.current
    if (!el) return
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 60) loadMore()
  }

  const markAsRead = async (id: string) => {
    await api.post(`/notifications/${id}/read`)
    setNotifications(prev => prev.map(n => n.id === id ? { ...n, isRead: true } : n))
    setUnreadCount(prev => Math.max(0, prev - 1))
  }

  const markAllAsRead = async () => {
    await api.post('/notifications/read-all')
    setNotifications(prev => prev.map(n => ({ ...n, isRead: true })))
    setUnreadCount(0)
  }

  const deleteNotification = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation()
    const n = notifications.find(x => x.id === id)
    await api.delete(`/notifications/${id}`)
    setNotifications(prev => prev.filter(x => x.id !== id))
    if (n && !n.isRead) setUnreadCount(prev => Math.max(0, prev - 1))
  }

  const deleteAll = async () => {
    await api.delete('/notifications/all')
    setNotifications([])
    setUnreadCount(0)
  }

  const handleClick = (n: Notification) => {
    if (!n.isRead) markAsRead(n.id)
    if (n.link) { navigate(n.link); setOpen(false) }
  }

  const getIcon = (type: string) => {
    switch (type) {
      case 'user_registered': return 'person_add'
      case 'user_approved': return 'check_circle'
      case 'user_disabled': return 'block'
      case 'user_enabled': return 'how_to_reg'
      default: return 'notifications'
    }
  }

  const getIconColor = (type: string) => {
    switch (type) {
      case 'user_registered': return 'var(--accent)'
      case 'user_approved': return 'var(--green)'
      case 'user_disabled': return 'var(--red)'
      case 'user_enabled': return 'var(--green)'
      default: return 'var(--text-secondary)'
    }
  }

  const timeAgo = (dateStr: string) => {
    const diff = Date.now() - new Date(dateStr).getTime()
    const mins = Math.floor(diff / 60000)
    if (mins < 1) return 'Vừa xong'
    if (mins < 60) return `${mins} phút trước`
    const hours = Math.floor(mins / 60)
    if (hours < 24) return `${hours} giờ trước`
    const days = Math.floor(hours / 24)
    return `${days} ngày trước`
  }

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <Badge count={unreadCount} size="small" offset={[-2, 2]}>
        <button className="icon-btn icon-btn-sm" onClick={() => setOpen(!open)}
          style={{ color: open ? 'var(--accent)' : 'var(--text-secondary)' }}>
          <span className="ms" style={{ fontSize: 22 }}>notifications</span>
        </button>
      </Badge>

      {open && (
        <div style={{ position: 'absolute', top: 'calc(100% + 8px)', right: 0, width: 360, background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 14, boxShadow: 'var(--shadow-lg)', zIndex: 1000, overflow: 'hidden', maxHeight: '70vh', display: 'flex', flexDirection: 'column' }}>
          {/* Header */}
          <div style={{ padding: '14px 16px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span style={{ fontSize: 15, fontWeight: 600 }}>Thông báo</span>
            <div style={{ display: 'flex', gap: 8 }}>
              {unreadCount > 0 && (
                <button onClick={markAllAsRead} style={{ fontSize: 11, color: 'var(--accent)', background: 'none', border: 'none', cursor: 'pointer', fontWeight: 500 }}>
                  Đọc tất cả
                </button>
              )}
              {notifications.length > 0 && (
                <button onClick={deleteAll} style={{ fontSize: 11, color: 'var(--red)', background: 'none', border: 'none', cursor: 'pointer', fontWeight: 500 }}>
                  Xóa tất cả
                </button>
              )}
            </div>
          </div>

          {/* Notification list */}
          <div ref={listRef} onScroll={handleScroll} style={{ overflowY: 'auto', flex: 1 }}>
            {notifications.length === 0 ? (
              <div style={{ padding: '40px 16px', textAlign: 'center', color: 'var(--text-muted)' }}>
                <span className="ms" style={{ fontSize: 40, display: 'block', marginBottom: 8 }}>notifications_off</span>
                <p style={{ fontSize: 13 }}>Chưa có thông báo nào</p>
              </div>
            ) : (
              notifications.map(n => (
                <div key={n.id} onClick={() => handleClick(n)}
                  style={{ padding: '12px 16px', display: 'flex', gap: 12, cursor: 'pointer', background: n.isRead ? 'transparent' : 'var(--accent-subtle)', borderBottom: '1px solid var(--border)', transition: 'background 0.2s', position: 'relative' }}
                  onMouseOver={e => { if (n.isRead) e.currentTarget.style.background = 'var(--bg-hover)' }}
                  onMouseOut={e => { e.currentTarget.style.background = n.isRead ? 'transparent' : 'var(--accent-subtle)' }}>
                  <div style={{ width: 36, height: 36, borderRadius: '50%', flexShrink: 0, background: 'var(--bg-surface)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <span className="ms" style={{ fontSize: 18, color: getIconColor(n.type) }}>{getIcon(n.type)}</span>
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <p style={{ fontSize: 13, fontWeight: n.isRead ? 400 : 600, marginBottom: 2, lineHeight: 1.3 }}>{n.title}</p>
                    <p style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.4, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{n.message}</p>
                    <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>{timeAgo(n.createdAt)}</p>
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, flexShrink: 0 }}>
                    {!n.isRead && <div style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--accent)' }} />}
                    <button onClick={(e) => deleteNotification(e, n.id)}
                      style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 2, color: 'var(--text-muted)', opacity: 0.6, transition: 'opacity 0.2s' }}
                      onMouseOver={e => { e.currentTarget.style.opacity = '1'; e.currentTarget.style.color = 'var(--red)' }}
                      onMouseOut={e => { e.currentTarget.style.opacity = '0.6'; e.currentTarget.style.color = 'var(--text-muted)' }}>
                      <span className="ms" style={{ fontSize: 16 }}>close</span>
                    </button>
                  </div>
                </div>
              ))
            )}
            {loadingMore && (
              <div style={{ padding: '12px', textAlign: 'center' }}>
                <span className="ms spin" style={{ fontSize: 20, color: 'var(--accent)' }}>progress_activity</span>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
