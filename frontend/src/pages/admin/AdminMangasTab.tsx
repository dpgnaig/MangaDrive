import { useEffect, useState } from 'react'
import { Switch, message } from 'antd'
import api from '../../lib/api'

interface MangaItem { id: string; title: string; isHidden: boolean; rootFolderName: string }

export default function AdminMangasTab() {
  const [mangas, setMangas] = useState<MangaItem[]>([])
  const [syncing, setSyncing] = useState<Set<string>>(new Set())
  useEffect(() => { api.get('/admin/mangas').then(r => setMangas(r.data)) }, [])

  const toggle = async (id: string) => {
    const { data } = await api.post(`/admin/mangas/${id}/toggle-visibility`)
    setMangas(mangas.map(m => m.id === id ? { ...m, isHidden: data.isHidden } : m))
  }

  const syncManga = async (id: string, title: string) => {
    setSyncing(prev => new Set(prev).add(id))
    try {
      await api.post(`/admin/mangas/${id}/sync`)
      message.success(`Đang sync "${title}"...`)
    } catch {
      message.error('Sync thất bại')
    }
    setTimeout(() => setSyncing(prev => { const s = new Set(prev); s.delete(id); return s }), 3000)
  }

  return (
    <>
      <h2 style={{ fontSize: 16, fontWeight: 600, marginBottom: 16 }}>Manga ({mangas.length})</h2>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {mangas.map(m => (
          <div key={m.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px', background: 'var(--bg-elevated)', borderRadius: 10, border: '1px solid var(--border)', opacity: m.isHidden ? 0.5 : 1, transition: 'opacity 0.3s' }}>
            <span className="ms ms-sm" style={{ color: m.isHidden ? 'var(--text-muted)' : 'var(--accent)' }}>{m.isHidden ? 'visibility_off' : 'visibility'}</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <p style={{ fontSize: 14, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.title}</p>
              <p style={{ fontSize: 12, color: 'var(--text-muted)' }}>{m.rootFolderName}</p>
            </div>
            <button
              onClick={() => syncManga(m.id, m.title)}
              disabled={syncing.has(m.id)}
              style={{ background: 'none', border: '1px solid var(--border)', borderRadius: 6, padding: '4px 10px', color: syncing.has(m.id) ? 'var(--text-muted)' : 'var(--green)', fontSize: 12, cursor: syncing.has(m.id) ? 'not-allowed' : 'pointer', display: 'flex', alignItems: 'center', gap: 4 }}>
              <span className={`ms ${syncing.has(m.id) ? 'spin' : ''}`} style={{ fontSize: 16 }}>{syncing.has(m.id) ? 'progress_activity' : 'sync'}</span>
              Sync
            </button>
            <Switch checked={!m.isHidden} onChange={() => toggle(m.id)} size="small" />
          </div>
        ))}
      </div>
    </>
  )
}
