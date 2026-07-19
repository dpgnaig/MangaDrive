import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import api from '../lib/api'
import AppLayout from '../components/AppLayout'
import { useAuth } from '../context/AuthContext'
import { useIsDesktop } from '../hooks/useBreakpoint'
import { NotificationsSkeleton } from '../components/Skeleton'

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

export default function Notifications() {
  const [notifications, setNotifications] = useState<Notification[]>([])
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [hasMore, setHasMore] = useState(true)
  const navigate = useNavigate()
  const { user } = useAuth()
  const isDesktop = useIsDesktop()

  // On desktop, notifications live in the TopNav bell dropdown — redirect to home.
  useEffect(() => {
    if (isDesktop) navigate('/', { replace: true })
  }, [isDesktop, navigate])

  useEffect(() => {
    api.get(`/notifications?skip=0&take=${PAGE_SIZE}`).then(r => {
      setNotifications(r.data)
      setHasMore(r.data.length === PAGE_SIZE)
    }).finally(() => setLoading(false))
    api.post('/notifications/read-all').catch(() => {})
  }, [])

  const loadMore = async () => {
    if (loadingMore || !hasMore) return
    setLoadingMore(true)
    try {
      const { data } = await api.get(`/notifications?skip=${notifications.length}&take=${PAGE_SIZE}`)
      setNotifications(prev => [...prev, ...data])
      setHasMore(data.length === PAGE_SIZE)
    } catch { /* ignore */ }
    setLoadingMore(false)
  }

  const handleClick = (n: Notification) => {
    // Chat-related notifications open the Messages page
    if (n.type === 'manga_request' || n.type === 'manga_request_response' || n.type === 'dm_message') {
      navigate('/messages')
      return
    }
    if (n.link) navigate(n.link)
  }

  const clearAll = async () => {
    await api.delete('/notifications/all')
    setNotifications([])
  }

  return (
    <AppLayout showSearch={false}>
      <div style={{ maxWidth: 600, margin: '0 auto' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
          <h1 style={{ fontSize: 18, fontWeight: 600 }}>Thông báo</h1>
          {notifications.length > 0 && (
            <button onClick={clearAll} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', fontSize: 13, cursor: 'pointer' }}>
              Xóa tất cả
            </button>
          )}
        </div>

        {loading && <NotificationsSkeleton />}

        {!loading && notifications.length === 0 && (
          <div style={{ textAlign: 'center', padding: '60px 20px' }}>
            <span className="ms" style={{ fontSize: 48, color: 'var(--text-muted)', display: 'block', marginBottom: 12 }}>notifications_none</span>
            <p style={{ color: 'var(--text-muted)', fontSize: 14 }}>Chưa có thông báo nào</p>
          </div>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {notifications.map(n => (
            <div key={n.id} onClick={() => handleClick(n)}
              style={{ padding: '14px 16px', background: n.isRead ? 'transparent' : 'var(--accent-subtle)', borderRadius: 10, cursor: (n.link || n.type === 'manga_request_response' || n.type === 'manga_request' || n.type === 'dm_message') ? 'pointer' : 'default', transition: 'background 0.2s', display: 'flex', gap: 12, alignItems: 'flex-start' }}>
              <span className="ms" style={{ fontSize: 20, color: n.isRead ? 'var(--text-muted)' : 'var(--accent)', marginTop: 2 }}>
                {n.type === 'new_chapters' ? 'auto_stories' : n.type === 'approved' ? 'check_circle' : n.type === 'manga_request' ? 'library_add' : n.type === 'manga_request_response' ? 'rate_review' : n.type === 'dm_message' ? 'forum' : 'notifications'}
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <p style={{ fontSize: 14, fontWeight: n.isRead ? 400 : 600, marginBottom: 3 }}>{n.title}</p>
                <p style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.4 }}>{n.message}</p>
                <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>{new Date(n.createdAt).toLocaleString()}</p>
              </div>
            </div>
          ))}
        </div>

        {!loading && hasMore && notifications.length > 0 && (
          <div style={{ textAlign: 'center', padding: '16px 0' }}>
            <button onClick={loadMore} disabled={loadingMore}
              style={{ padding: '8px 24px', borderRadius: 20, border: '1px solid var(--border)', background: 'var(--bg-elevated)', color: 'var(--text-secondary)', fontSize: 13, cursor: loadingMore ? 'default' : 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              {loadingMore
                ? <><span className="ms spin" style={{ fontSize: 16 }}>progress_activity</span> Đang tải...</>
                : <>Xem thêm</>}
            </button>
          </div>
        )}
      </div>
    </AppLayout>
  )
}
