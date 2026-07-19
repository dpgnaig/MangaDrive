import { useAuth } from '../context/AuthContext'
import AppLayout from '../components/AppLayout'

export default function Profile() {
  const { user, logout } = useAuth()

  return (
    <AppLayout showSearch={false} maxWidth={600}>
      <h1 style={{ fontSize: 20, fontWeight: 700, marginBottom: 20 }}>Tài khoản</h1>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: 16, background: 'var(--bg-elevated)', borderRadius: 12, marginBottom: 16 }}>
        <img src={user?.avatarUrl} style={{ width: 48, height: 48, borderRadius: '50%' }} />
        <div>
          <p style={{ fontWeight: 600 }}>{user?.displayName}</p>
          <p style={{ fontSize: 13, color: 'var(--text-secondary)' }}>{user?.email}</p>
        </div>
      </div>

      <button onClick={logout} style={{ width: '100%', padding: '14px 16px', background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 12, color: 'var(--red)', display: 'flex', alignItems: 'center', gap: 12, cursor: 'pointer', fontSize: 14 }}>
        <span className="ms ms-sm">logout</span>
        Đăng xuất
      </button>
    </AppLayout>
  )
}
