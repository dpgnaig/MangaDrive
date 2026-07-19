import { useEffect, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'

const GOOGLE_CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID
const REDIRECT_URI = window.location.origin + '/login'

export default function Login() {
  const { user, login } = useAuth()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const [error, setError] = useState('')
  const calledRef = useRef(false)

  useEffect(() => { if (user) navigate('/') }, [user, navigate])
  useEffect(() => {
    const code = searchParams.get('code')
    if (code && !calledRef.current) {
      calledRef.current = true
      login(code, REDIRECT_URI).then(() => navigate('/')).catch(e => setError(e?.response?.data || e.message))
    }
  }, [searchParams, login, navigate])

  const handleLogin = () => {
    window.location.href = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${GOOGLE_CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&response_type=code&scope=openid email profile&access_type=offline`
  }

  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
      <div style={{ width: '100%', maxWidth: 400, textAlign: 'center' }}>
        <div style={{ marginBottom: 32 }}>
          <img src="/logo.png" alt="MangaDrive" style={{ height: 128, margin: '0 auto 12px', mixBlendMode: 'lighten' }} />
          <p style={{ color: 'var(--text-secondary)', fontSize: 15 }}>Đọc manga mọi lúc mọi nơi</p>
        </div>

        {error && (
          <div style={{ background: 'rgba(255,59,59,0.1)', border: '1px solid rgba(255,59,59,0.3)', borderRadius: 'var(--radius-sm)', padding: '12px 16px', marginBottom: 20, color: 'var(--red)', fontSize: 13, textAlign: 'left' }}>
            {error}
          </div>
        )}

        {searchParams.get('code') ? (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10, color: 'var(--text-secondary)' }}>
            <span className="ms" style={{ animation: 'spin 1s linear infinite' }}>progress_activity</span>
            <span>Đang đăng nhập...</span>
          </div>
        ) : (
          <button onClick={handleLogin} style={{
            width: '100%', height: 52, borderRadius: 26, border: 'none',
            background: 'var(--accent)', color: '#fff', fontSize: 16, fontWeight: 600,
            cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10,
            boxShadow: '0 6px 24px rgba(255,107,44,0.3)', transition: 'all 0.2s'
          }}
            onMouseEnter={e => { e.currentTarget.style.background = 'var(--accent-hover)'; e.currentTarget.style.transform = 'translateY(-2px)' }}
            onMouseLeave={e => { e.currentTarget.style.background = 'var(--accent)'; e.currentTarget.style.transform = '' }}>
            <span className="ms">login</span> Đăng nhập với Google
          </button>
        )}
      </div>

      <style>{`@keyframes spin { to { transform: rotate(360deg) } }`}</style>
    </div>
  )
}
