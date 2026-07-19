import { useEffect } from 'react'
import { useAuth } from '../context/AuthContext'

export default function PendingApproval() {
  const { user, logout, refreshUser } = useAuth()

  // Poll every 5 seconds to check if user has been approved
  useEffect(() => {
    const interval = setInterval(() => {
      refreshUser()
    }, 5000)
    return () => clearInterval(interval)
  }, [refreshUser])

  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg-base)', padding: 24 }}>
      <div style={{ maxWidth: 420, width: '100%', textAlign: 'center', padding: '48px 32px', background: 'var(--bg-surface)', borderRadius: 16, border: '1px solid var(--border)' }}>
        <div style={{ width: 80, height: 80, borderRadius: '50%', background: 'var(--accent-subtle)', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 24px' }}>
          <span className="ms" style={{ fontSize: 40, color: 'var(--accent)' }}>hourglass_top</span>
        </div>

        <h1 style={{ fontSize: 22, fontWeight: 700, marginBottom: 12 }}>Chờ phê duyệt</h1>
        <p style={{ fontSize: 14, color: 'var(--text-secondary)', lineHeight: 1.6, marginBottom: 8 }}>
          Tài khoản của bạn đang chờ admin phê duyệt.<br />
          Bạn sẽ có thể truy cập nội dung sau khi được duyệt.
        </p>
        <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 24 }}>
          Trang sẽ tự động chuyển hướng khi tài khoản được duyệt.
        </p>

        <div style={{ padding: '16px 20px', background: 'var(--bg-elevated)', borderRadius: 12, marginBottom: 24, display: 'flex', alignItems: 'center', gap: 12 }}>
          {user?.avatarUrl && <img src={user.avatarUrl} style={{ width: 40, height: 40, borderRadius: '50%' }} alt="" />}
          <div style={{ textAlign: 'left' }}>
            <p style={{ fontSize: 14, fontWeight: 500 }}>{user?.displayName}</p>
            <p style={{ fontSize: 12, color: 'var(--text-muted)' }}>{user?.email}</p>
          </div>
          <span className="ms spin" style={{ marginLeft: 'auto', fontSize: 18, color: 'var(--text-muted)' }}>progress_activity</span>
        </div>

        <button
          onClick={logout}
          style={{ width: '100%', padding: '12px 24px', borderRadius: 10, border: '1px solid var(--border)', background: 'var(--bg-elevated)', color: 'var(--text)', fontSize: 14, fontWeight: 500, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, transition: 'all 0.2s' }}
          onMouseOver={e => { e.currentTarget.style.borderColor = 'var(--red)'; e.currentTarget.style.color = 'var(--red)' }}
          onMouseOut={e => { e.currentTarget.style.borderColor = 'var(--border)'; e.currentTarget.style.color = 'var(--text)' }}
        >
          <span className="ms" style={{ fontSize: 18 }}>logout</span>
          Đăng xuất
        </button>
      </div>
    </div>
  )
}
