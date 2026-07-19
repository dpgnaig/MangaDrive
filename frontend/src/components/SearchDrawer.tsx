import { useState, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router-dom'
import { getMangas } from '../lib/cache'
import { imgUrl } from '../lib/img'

interface Manga { id: string; title: string; author: string; coverImageFileId: string; chapterCount: number }

interface Props {
  open: boolean
  onClose: () => void
}

export default function SearchDrawer({ open, onClose }: Props) {
  const [mangas, setMangas] = useState<Manga[]>([])
  const [query, setQuery] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const navigate = useNavigate()

  useEffect(() => {
    if (open) {
      getMangas().then(setMangas).catch(() => {})
      setTimeout(() => inputRef.current?.focus(), 150)
    } else {
      setQuery('')
    }
  }, [open])

  const results = query.trim()
    ? mangas.filter(m => m.title.toLowerCase().includes(query.toLowerCase()))
    : []

  const goToManga = (id: string) => {
    onClose()
    navigate(`/manga/${id}`)
  }

  if (!open) return null

  return createPortal(
    <>
      {/* Backdrop */}
      <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(6px)', WebkitBackdropFilter: 'blur(6px)', zIndex: 9998 }} />

      {/* Search panel */}
      <div className="search-drawer" style={{
        position: 'fixed', zIndex: 9999,
        background: 'var(--bg-base)',
        display: 'flex', flexDirection: 'column', overflow: 'hidden',
        animation: 'search-drawer-in 0.2s ease'
      }}>
        {/* Input + close */}
        <div style={{ padding: '16px 16px 12px', display: 'flex', gap: 10, alignItems: 'center' }}>
          <div style={{ flex: 1, position: 'relative' }}>
            <span className="ms" style={{ position: 'absolute', left: 14, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)', fontSize: 20 }}>search</span>
            <input
              ref={inputRef}
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="Tìm kiếm manga..."
              style={{ width: '100%', height: 44, borderRadius: 10, border: '1px solid var(--border)', background: 'var(--bg-elevated)', color: 'var(--text)', paddingLeft: 44, paddingRight: 14, fontSize: 15, outline: 'none' }}
              onFocus={e => e.currentTarget.style.borderColor = 'var(--accent)'}
              onBlur={e => e.currentTarget.style.borderColor = 'var(--border)'}
              onKeyDown={e => e.key === 'Escape' && onClose()}
            />
          </div>
          <button onClick={onClose}
            style={{ width: 36, height: 36, borderRadius: '50%', background: 'var(--bg-hover)', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-secondary)', flexShrink: 0 }}>
            <span className="ms" style={{ fontSize: 20 }}>close</span>
          </button>
        </div>

        {/* Results */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '0 16px 16px' }}>
          {!query.trim() && (
            <div style={{ textAlign: 'center', padding: '50px 16px', color: 'var(--text-muted)' }}>
              <span className="ms" style={{ fontSize: 36, display: 'block', marginBottom: 8 }}>search</span>
              <p style={{ fontSize: 13 }}>Nhập tên manga để tìm kiếm</p>
            </div>
          )}
          {query.trim() && results.length === 0 && (
            <div style={{ textAlign: 'center', padding: '50px 16px', color: 'var(--text-muted)' }}>
              <span className="ms" style={{ fontSize: 36, display: 'block', marginBottom: 8 }}>search_off</span>
              <p style={{ fontSize: 13 }}>Không tìm thấy "{query}"</p>
            </div>
          )}
          {results.map(m => (
            <div key={m.id} onClick={() => goToManga(m.id)}
              style={{ display: 'flex', gap: 12, padding: '10px 12px', borderRadius: 10, alignItems: 'center', cursor: 'pointer', transition: 'background 0.15s', borderBottom: '1px solid var(--border)' }}
              onMouseOver={e => e.currentTarget.style.background = 'var(--bg-hover)'}
              onMouseOut={e => e.currentTarget.style.background = 'transparent'}>
              <div style={{ width: 42, height: 56, borderRadius: 6, overflow: 'hidden', flexShrink: 0, background: 'var(--bg-hover)' }}>
                {m.coverImageFileId && <img src={imgUrl(m.coverImageFileId)} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <p style={{ fontSize: 14, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.title}</p>
                {m.author && <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>{m.author}</p>}
              </div>
              <span style={{ fontSize: 12, color: 'var(--text-muted)', flexShrink: 0 }}>{m.chapterCount} ch</span>
            </div>
          ))}
        </div>
      </div>
    </>,
    document.body
  )
}
