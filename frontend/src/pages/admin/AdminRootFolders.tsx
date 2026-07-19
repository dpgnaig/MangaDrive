import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Button, Progress } from 'antd'
import * as signalR from '@microsoft/signalr'
import api from '../../lib/api'

interface RootFolder { id: string; name: string; googleDriveFolderId: string; isPublic: boolean; isActive: boolean }
interface SyncProgress { syncJobId: string; rootFolderId: string; status: string; percent: number; message: string; currentMangaTotalChapter: number; currentMangaSyncedChapter: number; currentMangaNewChapters: number }

function AdminNav({ active }: { active: string }) {
  const links = [
    { key: 'root-folders', label: 'Sources', icon: 'folder' },
    { key: 'mangas', label: 'Mangas', icon: 'auto_stories' },
    { key: 'users', label: 'Users', icon: 'group' },
  ]
  return (
    <nav style={{ position: 'sticky', top: 0, zIndex: 100, background: 'rgba(13,13,13,0.9)', backdropFilter: 'blur(12px)', borderBottom: '1px solid var(--border)', padding: '10px 20px', display: 'flex', alignItems: 'center', gap: 8 }}>
      <Link to="/"><button className="icon-btn icon-btn-sm"><span className="ms">arrow_back</span></button></Link>
      <h1 style={{ fontSize: 16, fontWeight: 700, color: 'var(--accent)', marginRight: 16 }}>Admin</h1>
      {links.map(l => (
        <Link key={l.key} to={`/admin/${l.key}`}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 12px', borderRadius: 8, fontSize: 13, fontWeight: 500, background: active === l.key ? 'var(--accent-subtle)' : 'transparent', color: active === l.key ? 'var(--accent)' : 'var(--text-secondary)', transition: 'all 0.2s' }}>
            <span className="ms ms-sm">{l.icon}</span>{l.label}
          </span>
        </Link>
      ))}
    </nav>
  )
}
export { AdminNav }

export default function AdminRootFolders() {
  const [folders, setFolders] = useState<RootFolder[]>([])
  const [progress, setProgress] = useState<Record<string, SyncProgress>>({})
  const [showModal, setShowModal] = useState(false)

  useEffect(() => { load() }, [])
  useEffect(() => {
    const conn = new signalR.HubConnectionBuilder()
      .withUrl(`/hubs/sync`, { accessTokenFactory: () => localStorage.getItem('token') || '' })
      .withAutomaticReconnect().build()
    conn.start()
    conn.on('SyncProgress', (p: SyncProgress) => setProgress(prev => ({ ...prev, [p.rootFolderId]: p })))
    return () => { conn.stop() }
  }, [])

  const load = () => api.get('/admin/root-folders').then(r => setFolders(r.data))
  const createFromForm = async () => {
    const name = (document.getElementById('rf-name') as HTMLInputElement).value.trim()
    const googleDriveFolderId = (document.getElementById('rf-folderId') as HTMLInputElement).value.trim()
    if (!name || !googleDriveFolderId) return
    await api.post('/admin/root-folders', { name, googleDriveFolderId, isPublic: true })
    setShowModal(false); load()
  }
  const del = async (id: string) => { await api.delete(`/admin/root-folders/${id}`); load() }
  const sync = (id: string) => api.post(`/admin/root-folders/${id}/sync`)

  return (
    <div style={{ minHeight: '100vh' }}>
      <AdminNav active="root-folders" />
      <main style={{ padding: 20, maxWidth: 800, margin: '0 auto' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
          <h2 style={{ fontSize: 18, fontWeight: 600 }}>Drive Sources</h2>
          <Button type="primary" onClick={() => setShowModal(true)} style={{ borderRadius: 20, height: 38 }}>
            <span className="ms ms-sm">add</span> Thêm
          </Button>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {folders.map(f => {
            const syncing = progress[f.id]?.status === 'Running'
            return (
            <div key={f.id} style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: 16, gap: 12 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <p style={{ fontWeight: 600, fontSize: 14 }}>{f.name} {f.isPublic && <span style={{ color: 'var(--green)', fontSize: 11, fontWeight: 500, marginLeft: 6 }}>● Public</span>}</p>
                  <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4, overflow: 'hidden', textOverflow: 'ellipsis' }}>{f.googleDriveFolderId}</p>
                </div>
                <div style={{ display: 'flex', gap: 6 }}>
                  <button className="icon-btn icon-btn-sm" onClick={() => sync(f.id)} title="Sync" disabled={syncing}
                    style={syncing ? { animation: 'spin 1s linear infinite' } : {}}>
                    <span className="ms">sync</span>
                  </button>
                <button className="icon-btn icon-btn-sm" onClick={() => del(f.id)} title="Xóa" style={{ color: 'var(--red)' }}><span className="ms">delete</span></button>
                </div>
              </div>
              {syncing && (
                <div style={{ marginTop: 14 }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
                    <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{progress[f.id].message}</span>
                    <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--accent)' }}>{progress[f.id].percent}%</span>
                  </div>
                  <div style={{ height: 6, borderRadius: 3, background: 'var(--bg-hover)', overflow: 'hidden' }}>
                    <div style={{ height: '100%', borderRadius: 3, background: 'var(--accent)', width: `${progress[f.id].percent}%`, transition: 'width 0.3s ease', boxShadow: '0 0 8px rgba(255,107,44,0.5)' }} />
                  </div>
                </div>
              )}
            </div>
          )})}
        </div>
      </main>

      {/* Modal */}
      {showModal && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}
          onClick={() => setShowModal(false)}>
          <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(4px)' }} />
          <div onClick={e => e.stopPropagation()} style={{ position: 'relative', width: '100%', maxWidth: 440, background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 16, overflow: 'hidden', boxShadow: '0 24px 64px rgba(0,0,0,0.5)' }}>
            <div style={{ padding: '20px 24px 16px', borderBottom: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <h3 style={{ fontSize: 18, fontWeight: 600 }}>Thêm Drive Source</h3>
              <button className="icon-btn icon-btn-sm" onClick={() => setShowModal(false)}><span className="ms">close</span></button>
            </div>
            <div style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 16 }}>
              <div>
                <label style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-secondary)', display: 'block', marginBottom: 6 }}>Tên hiển thị</label>
                <input id="rf-name" placeholder="VD: Shounen Collection" style={{ width: '100%', height: 42, borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg-elevated)', color: 'var(--text)', padding: '0 14px', fontSize: 14, outline: 'none', transition: 'border-color 0.2s' }}
                  onFocus={e => e.currentTarget.style.borderColor = 'var(--accent)'} onBlur={e => e.currentTarget.style.borderColor = 'var(--border)'} />
              </div>
              <div>
                <label style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-secondary)', display: 'block', marginBottom: 6 }}>Google Drive Folder ID</label>
                <input id="rf-folderId" placeholder="Paste folder ID from Drive URL" style={{ width: '100%', height: 42, borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg-elevated)', color: 'var(--text)', padding: '0 14px', fontSize: 14, outline: 'none', transition: 'border-color 0.2s', fontFamily: 'monospace' }}
                  onFocus={e => e.currentTarget.style.borderColor = 'var(--accent)'} onBlur={e => e.currentTarget.style.borderColor = 'var(--border)'} />
                <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 6 }}>Lấy từ URL: drive.google.com/drive/folders/<strong>ID_Ở_ĐÂY</strong></p>
              </div>
            </div>
            <div style={{ padding: '16px 24px', borderTop: '1px solid var(--border)', display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
              <button onClick={() => setShowModal(false)} style={{ height: 38, padding: '0 20px', borderRadius: 8, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text)', fontSize: 14, fontWeight: 500, cursor: 'pointer' }}>Hủy</button>
              <button onClick={createFromForm} style={{ height: 38, padding: '0 20px', borderRadius: 8, border: 'none', background: 'var(--accent)', color: '#fff', fontSize: 14, fontWeight: 600, cursor: 'pointer', boxShadow: '0 4px 12px rgba(255,107,44,0.3)' }}>Thêm</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
