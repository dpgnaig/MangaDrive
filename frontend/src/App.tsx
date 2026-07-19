import { Routes, Route, Navigate, useLocation } from 'react-router-dom'
import { AuthProvider, useAuth } from './context/AuthContext'
import Login from './pages/Login'
import PendingApproval from './pages/PendingApproval'
import Onboarding from './pages/Onboarding'
import MangaList from './pages/MangaList'
import MangaDetail from './pages/MangaDetail'
import ChapterReader from './pages/ChapterReader'
import Favorites from './pages/Favorites'
import Notifications from './pages/Notifications'
import Profile from './pages/Profile'
import Admin from './pages/admin/Admin'
import BottomNav from './components/BottomNav'
import Messages from './pages/Messages'
import { MessengerProvider } from './context/MessengerContext'
import ChatWindowDock from './components/messenger/ChatWindowDock'
import MessengerBreakpointSync from './components/messenger/MessengerBreakpointSync'

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth()
  if (loading) return <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><span className="ms spin" style={{ fontSize: 32, color: 'var(--accent)' }}>progress_activity</span></div>
  if (!user) return <Navigate to="/login" />
  if (!user.isApproved && user.role !== 'Admin') return <Navigate to="/pending" />
  if (!user.isProfileCompleted) return <Navigate to="/onboarding" />
  return <>{children}</>
}

function AppBottomNav() {
  const { user } = useAuth()
  const { pathname } = useLocation()
  // Hide on login, pending, chapter reader, admin, manga detail
  const hide = !user || !user.isApproved || !user.isProfileCompleted || pathname.startsWith('/login') || pathname.startsWith('/pending') || pathname.startsWith('/onboarding') || pathname.startsWith('/chapter/') || pathname.startsWith('/admin') || pathname.startsWith('/manga/')
  if (hide) return null
  return <BottomNav />
}

export default function App() {
  return (
    <AuthProvider>
      <MessengerProvider>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/pending" element={<PendingRoute />} />
        <Route path="/onboarding" element={<OnboardingRoute />} />
        <Route path="/" element={<ProtectedRoute><MangaList /></ProtectedRoute>} />
        <Route path="/favorites" element={<ProtectedRoute><Favorites /></ProtectedRoute>} />
        <Route path="/notifications" element={<ProtectedRoute><Notifications /></ProtectedRoute>} />
        {/* Single splat route so navigating list <-> thread does NOT remount
            Messages (keeps one stable SignalR connection for realtime). */}
        <Route path="/messages/*" element={<ProtectedRoute><Messages /></ProtectedRoute>} />
        <Route path="/profile" element={<ProtectedRoute><Profile /></ProtectedRoute>} />
        <Route path="/manga/:id" element={<ProtectedRoute><MangaDetail /></ProtectedRoute>} />
        <Route path="/chapter/:id" element={<ProtectedRoute><ChapterReader /></ProtectedRoute>} />
        <Route path="/admin/*" element={<ProtectedRoute><Admin /></ProtectedRoute>} />
        {/* Redirect old library URLs */}
        <Route path="/library" element={<Navigate to="/favorites" replace />} />
      </Routes>
      <AppBottomNav />
      <ChatWindowDock />
      <MessengerBreakpointSync />
      </MessengerProvider>
    </AuthProvider>
  )
}

function PendingRoute() {
  const { user, loading } = useAuth()
  if (loading) return <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><span className="ms spin" style={{ fontSize: 32, color: 'var(--accent)' }}>progress_activity</span></div>
  if (!user) return <Navigate to="/login" />
  if (user.isApproved || user.role === 'Admin') return <Navigate to="/" />
  return <PendingApproval />
}

function OnboardingRoute() {
  const { user, loading } = useAuth()
  if (loading) return <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><span className="ms spin" style={{ fontSize: 32, color: 'var(--accent)' }}>progress_activity</span></div>
  if (!user) return <Navigate to="/login" />
  if (user.isProfileCompleted) return <Navigate to="/" />
  return <Onboarding />
}
