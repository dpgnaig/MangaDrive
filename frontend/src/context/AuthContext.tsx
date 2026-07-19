import { createContext, useContext, useState, useEffect, useCallback, ReactNode } from 'react'
import axios from 'axios'
import api from '../lib/api'

interface User {
  id: string; email: string; displayName: string; avatarUrl: string; role: string; isApproved: boolean; isProfileCompleted: boolean; hasChangedName: boolean
}

interface AuthCtx {
  user: User | null
  loading: boolean
  login: (code: string, redirectUri: string) => Promise<void>
  logout: () => void
  refreshUser: () => Promise<void>
}

const AuthContext = createContext<AuthCtx>({} as AuthCtx)
export const useAuth = () => useContext(AuthContext)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [loading, setLoading] = useState(true)

  const refreshUser = useCallback(async () => {
    try {
      const { data } = await api.get('/auth/me')
      setUser(data)
    } catch {
      localStorage.removeItem('token')
      setUser(null)
    }
  }, [])

  // On boot: if we have an access token, verify it (the api interceptor auto-refreshes
  // on 401). If we don't, still try one refresh — a returning user may have a valid
  // refresh cookie even though the short-lived access token is gone from localStorage.
  useEffect(() => {
    const boot = async () => {
      if (localStorage.getItem('token')) {
        await refreshUser()
      } else {
        try {
          const { data } = await axios.post('/api/auth/refresh', null, { withCredentials: true })
          localStorage.setItem('token', data.token)
          setUser(data.user)
        } catch {
          localStorage.removeItem('token')
          setUser(null)
        }
      }
      setLoading(false)
    }
    boot()
  }, [refreshUser])

  const login = async (code: string, redirectUri: string) => {
    const { data } = await api.post('/auth/google-login', { code, redirectUri })
    localStorage.setItem('token', data.token)
    setUser(data.user)
  }

  const logout = async () => {
    try { await api.post('/auth/logout') } catch { /* revoke is best-effort */ }
    localStorage.removeItem('token')
    setUser(null)
    window.location.href = '/login'
  }

  return <AuthContext.Provider value={{ user, loading, login, logout, refreshUser }}>{children}</AuthContext.Provider>
}
