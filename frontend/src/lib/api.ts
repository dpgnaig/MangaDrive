import axios from 'axios'

const api = axios.create({ baseURL: '/api', withCredentials: true })

api.interceptors.request.use(config => {
  const token = localStorage.getItem('token')
  if (token) config.headers.Authorization = `Bearer ${token}`
  return config
})

// Single-flight refresh: when the access token expires, the first 401 triggers one
// POST /auth/refresh (using the HttpOnly refresh cookie); any other requests that 401
// in the meantime wait on the same promise, then retry with the new token.
let refreshing: Promise<string | null> | null = null

function runRefresh(): Promise<string | null> {
  if (!refreshing) {
    refreshing = axios.post('/api/auth/refresh', null, { withCredentials: true })
      .then(r => {
        const token = r.data.token as string
        localStorage.setItem('token', token)
        return token
      })
      .catch(() => {
        localStorage.removeItem('token')
        return null
      })
      .finally(() => { refreshing = null })
  }
  return refreshing
}

api.interceptors.response.use(
  response => response,
  async error => {
    const original = error.config
    const status = error.response?.status
    const url: string = original?.url || ''

    // Never try to refresh the refresh/login calls themselves, and only retry once.
    const isAuthCall = url.includes('/auth/refresh') || url.includes('/auth/logout') || url.includes('/auth/google-login')

    if (status === 401 && original && !original._retried && !isAuthCall) {
      original._retried = true
      const token = await runRefresh()
      if (token) {
        original.headers = original.headers || {}
        original.headers.Authorization = `Bearer ${token}`
        return api(original)
      }
      // Refresh failed → session is over.
      if (window.location.pathname !== '/login') window.location.href = '/login'
    }
    return Promise.reject(error)
  }
)

export default api
