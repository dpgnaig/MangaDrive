import { useState, useEffect } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Badge } from 'antd'
import { getMangas } from '../lib/cache'
import { imgUrl } from '../lib/img'

interface Manga { id: string; title: string; author: string; coverImageFileId: string; chapterCount: number }

export default function Search() {
  const [mangas, setMangas] = useState<Manga[]>([])
  const [query, setQuery] = useState('')
  const navigate = useNavigate()

  useEffect(() => { getMangas().then(setMangas).catch(() => {}) }, [])

  const results = query.trim() ? mangas.filter(m => m.title.toLowerCase().includes(query.toLowerCase())) : []

  return (
    <div style={{ minHeight: '100vh' }}>
      {/* Search header */}
      <div style={{ position: 'sticky', top: 0, zIndex: 100, background: 'rgba(13,13,13,0.95)', backdropFilter: 'blur(12px)', borderBottom: '1px solid var(--border)', padding: '10px 12px', display: 'flex', gap: 10, alignItems: 'center' }}>
        <button className="icon-btn icon-btn-sm" onClick={() => navigate(-1)}>
          <span className="ms">arrow_back</span>
        </button>
        <div style={{ flex: 1, position: 'relative' }}>
          <span className="ms ms-sm" style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)', pointerEvents: 'none' }}>search</span>
          <input autoFocus value={query} onChange={e => setQuery(e.target.value)} placeholder="Tìm kiếm manga..."
            style={{ width: '100%', height: 40, borderRadius: 20, border: '1px solid var(--border)', background: 'var(--bg-elevated)', color: 'var(--text)', paddingLeft: 40, paddingRight: 14, fontSize: 15, outline: 'none' }}
            onFocus={e => e.currentTarget.style.borderColor = 'var(--accent)'}
            onBlur={e => e.currentTarget.style.borderColor = 'var(--border)'} />
        </div>
      </div>

      {/* Results */}
      <div style={{ padding: 12 }}>
        {!query.trim() && (
          <p style={{ color: 'var(--text-muted)', textAlign: 'center', padding: 32 }}>Nhập tên manga để tìm kiếm</p>
        )}
        {query.trim() && results.length === 0 && (
          <p style={{ color: 'var(--text-muted)', textAlign: 'center', padding: 32 }}>Không tìm thấy kết quả</p>
        )}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {results.map(m => (
            <Link key={m.id} to={`/manga/${m.id}`}>
              <div style={{ display: 'flex', gap: 12, padding: 10, background: 'var(--bg-elevated)', borderRadius: 10, alignItems: 'center' }}>
                <div style={{ width: 44, height: 60, borderRadius: 6, overflow: 'hidden', flexShrink: 0, background: 'var(--bg-hover)' }}>
                  {m.coverImageFileId && <img src={imgUrl(m.coverImageFileId)} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <p style={{ fontSize: 14, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.title}</p>
                  {m.author && <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>{m.author}</p>}
                </div>
                <Badge count={m.chapterCount} style={{ background: 'var(--bg-hover)', color: 'var(--text-secondary)' }} />
              </div>
            </Link>
          ))}
        </div>
      </div>
    </div>
  )
}
