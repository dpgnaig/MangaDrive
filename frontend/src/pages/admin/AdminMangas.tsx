import { useEffect, useState } from 'react'
import { Switch } from 'antd'
import { AdminNav } from './AdminRootFolders'
import api from '../../lib/api'

interface MangaItem { id: string; title: string; isHidden: boolean; rootFolderName: string }

export default function AdminMangas() {
  const [mangas, setMangas] = useState<MangaItem[]>([])
  useEffect(() => { api.get('/admin/mangas').then(r => setMangas(r.data)) }, [])

  const toggle = async (id: string) => {
    const { data } = await api.post(`/admin/mangas/${id}/toggle-visibility`)
    setMangas(mangas.map(m => m.id === id ? { ...m, isHidden: data.isHidden } : m))
  }

  return (
    <div style={{ minHeight: '100vh' }}>
      <AdminNav active="mangas" />
      <main style={{ padding: 20, maxWidth: 800, margin: '0 auto' }}>
        <h2 style={{ fontSize: 18, fontWeight: 600, marginBottom: 20 }}>Manga Visibility ({mangas.length})</h2>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {mangas.map(m => (
            <div key={m.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px', background: 'var(--bg-elevated)', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)', opacity: m.isHidden ? 0.5 : 1, transition: 'opacity 0.3s' }}>
              <span className="ms ms-sm" style={{ color: m.isHidden ? 'var(--text-muted)' : 'var(--accent)' }}>{m.isHidden ? 'visibility_off' : 'visibility'}</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <p style={{ fontSize: 14, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.title}</p>
                <p style={{ fontSize: 12, color: 'var(--text-muted)' }}>{m.rootFolderName}</p>
              </div>
              <Switch checked={!m.isHidden} onChange={() => toggle(m.id)} size="small" />
            </div>
          ))}
        </div>
      </main>
    </div>
  )
}
