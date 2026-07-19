import { useEffect, useState, useCallback } from 'react'
import { Modal, message } from 'antd'
import api from '../lib/api'

interface MetadataTitle { lang: string; title: string }
interface Candidate {
  source: string
  externalId: string
  title: string
  otherTitles: MetadataTitle[]
  description: string
  author: string
  status: string
  genres: string[]
  coverUrl: string | null
  bannerUrl: string | null
  detailUrl: string | null
}

const SOURCES = ['anilist', 'mangadex'] as const

/** Which fields the admin wants to apply from the chosen candidate. */
interface FieldFlags {
  title: boolean
  otherTitles: boolean
  description: boolean
  author: boolean
  status: boolean
  genres: boolean
  cover: boolean
  banner: boolean
}

const DEFAULT_FLAGS: FieldFlags = {
  title: true, otherTitles: true, description: true, author: true,
  status: true, genres: true, cover: true, banner: true,
}

/**
 * Admin-only metadata picker. On open it queries AniList + MangaDex in parallel
 * (no manual search needed), lists all matches together, and lets the admin pick
 * one and choose which fields to apply before PATCHing the manga.
 */
export default function MetadataPickerModal({ open, onClose, mangaId, initialQuery, onApplied }: {
  open: boolean
  onClose: () => void
  mangaId: string
  initialQuery: string
  onApplied: () => void
}) {
  const [searching, setSearching] = useState(false)
  const [results, setResults] = useState<Candidate[]>([])
  const [selected, setSelected] = useState<Candidate | null>(null)
  const [flags, setFlags] = useState<FieldFlags>(DEFAULT_FLAGS)
  const [applying, setApplying] = useState(false)

  const search = useCallback(async (q: string) => {
    if (!q.trim()) return
    setSearching(true)
    setResults([])
    setSelected(null)
    try {
      // Query both sources in parallel and merge; a failing source contributes nothing.
      const settled = await Promise.all(SOURCES.map(source =>
        api.get('/admin/metadata/search', { params: { source, q: q.trim() } })
          .then(r => r.data as Candidate[])
          .catch(() => [] as Candidate[])
      ))
      const merged = settled.flat()
      setResults(merged)
      if (merged.length === 0) message.info('Không tìm thấy kết quả')
    } catch {
      message.error('Lỗi khi tìm kiếm metadata')
    }
    setSearching(false)
  }, [])

  // Auto-search both sources whenever the modal opens.
  useEffect(() => {
    if (open) search(initialQuery)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const apply = async () => {
    if (!selected) return
    setApplying(true)
    try {
      await api.post(`/admin/metadata/apply/${mangaId}`, {
        title: selected.title,
        otherTitles: selected.otherTitles,
        description: selected.description,
        author: selected.author,
        status: selected.status,
        genres: selected.genres,
        coverUrl: selected.coverUrl,
        bannerUrl: selected.bannerUrl,
        applyTitle: flags.title,
        applyOtherTitles: flags.otherTitles,
        applyDescription: flags.description,
        applyAuthor: flags.author,
        applyStatus: flags.status,
        applyGenres: flags.genres,
        applyCover: flags.cover,
        applyBanner: flags.banner,
      })
      message.success('Đã cập nhật metadata')
      onApplied()
      close()
    } catch {
      message.error('Lỗi khi áp dụng metadata')
    }
    setApplying(false)
  }

  const close = () => {
    setResults([]); setSelected(null); setFlags(DEFAULT_FLAGS)
    onClose()
  }

  const toggle = (k: keyof FieldFlags) => setFlags(f => ({ ...f, [k]: !f[k] }))

  const chipStyle = (active: boolean): React.CSSProperties => ({
    padding: '6px 14px', borderRadius: 20, fontSize: 13, fontWeight: 600, cursor: 'pointer',
    border: `1px solid ${active ? 'var(--accent)' : 'var(--border)'}`,
    background: active ? 'var(--accent)' : 'transparent',
    color: active ? '#fff' : 'var(--text-secondary)',
  })

  return (
    <Modal open={open} onCancel={close} title="Lấy metadata từ nguồn ngoài" centered footer={null} width={720}
      styles={{ body: { maxHeight: '70vh', overflowY: 'auto', paddingTop: 8 } }}>
      {/* Header: result count + a manual refresh (results auto-fetch on open). */}
      {!searching && results.length > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
          <span style={{ fontSize: 13, color: 'var(--text-muted)', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {results.length} kết quả cho "<span style={{ color: 'var(--text-secondary)', fontWeight: 600 }}>{initialQuery}</span>"
          </span>
          <button onClick={() => search(initialQuery)} title="Tìm lại"
            style={{ height: 34, padding: '0 14px', borderRadius: 8, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-secondary)', fontSize: 13, fontWeight: 500, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
            <span className="ms" style={{ fontSize: 16 }}>refresh</span>Tìm lại
          </button>
        </div>
      )}

      {/* Loading state */}
      {searching && (
        <div style={{ textAlign: 'center', padding: '32px 0' }}>
          <span className="ms spin" style={{ fontSize: 28, color: 'var(--accent)' }}>progress_activity</span>
          <p style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 8 }}>Đang tìm từ AniList & MangaDex...</p>
        </div>
      )}

      {/* Results grid */}
      {!searching && results.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))', gap: 10, marginBottom: 16 }}>
          {results.map(c => {
            const active = selected?.externalId === c.externalId && selected?.source === c.source
            return (
              <button key={`${c.source}-${c.externalId}`} onClick={() => setSelected(c)}
                style={{ textAlign: 'left', padding: 6, borderRadius: 10, cursor: 'pointer', background: 'transparent', border: `2px solid ${active ? 'var(--accent)' : 'var(--border)'}` }}>
                <div style={{ position: 'relative', width: '100%', aspectRatio: '2/3', borderRadius: 6, overflow: 'hidden', background: 'var(--bg-hover)', marginBottom: 6 }}>
                  {c.coverUrl && <img src={c.coverUrl} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />}
                  <span style={{ position: 'absolute', top: 4, left: 4, fontSize: 9, fontWeight: 700, padding: '2px 6px', borderRadius: 4, background: 'rgba(0,0,0,0.7)', color: '#fff' }}>{c.source}</span>
                </div>
                <p style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.title}</p>
              </button>
            )
          })}
        </div>
      )}

      {/* Selected preview + field toggles */}
      {selected && (
        <div style={{ borderTop: '1px solid var(--border)', paddingTop: 16 }}>
          <div style={{ display: 'flex', gap: 14, marginBottom: 14 }}>
            {selected.coverUrl && (
              <img src={selected.coverUrl} alt="" style={{ width: 90, aspectRatio: '2/3', objectFit: 'cover', borderRadius: 8, flexShrink: 0 }} />
            )}
            <div style={{ minWidth: 0, flex: 1 }}>
              <h3 style={{ fontSize: 16, fontWeight: 700, marginBottom: 4 }}>{selected.title}</h3>
              {selected.author && <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 4 }}>{selected.author}</p>}
              {selected.status && <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 6, textTransform: 'uppercase' }}>{selected.status}</p>}
              {selected.genres.length > 0 && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 6 }}>
                  {selected.genres.map(g => (
                    <span key={g} style={{ fontSize: 10, fontWeight: 600, color: 'var(--text-secondary)', padding: '2px 7px', background: 'var(--bg-hover)', borderRadius: 4 }}>{g}</span>
                  ))}
                </div>
              )}
              {selected.description && (
                <p style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.5, maxHeight: 90, overflow: 'hidden' }}>{selected.description}</p>
              )}
            </div>
          </div>

          {selected.bannerUrl && (
            <div style={{ marginBottom: 14 }}>
              <p style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>Banner</p>
              <img src={selected.bannerUrl} alt="" style={{ width: '100%', height: 90, objectFit: 'cover', borderRadius: 8 }} />
            </div>
          )}

          {/* Field toggles */}
          <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 8 }}>Chọn trường muốn cập nhật:</p>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 16 }}>
            {([
              ['title', 'Tên'],
              ['otherTitles', 'Tên khác'],
              ['description', 'Mô tả'],
              ['author', 'Tác giả'],
              ['status', 'Trạng thái'],
              ['genres', 'Thể loại'],
              ['cover', 'Ảnh bìa'],
              ['banner', 'Banner'],
            ] as [keyof FieldFlags, string][])
              .filter(([k]) => {
                if (k === 'cover') return !!selected.coverUrl
                if (k === 'banner') return !!selected.bannerUrl
                return true
              })
              .map(([k, label]) => (
                <button key={k} onClick={() => toggle(k)} style={chipStyle(flags[k])}>
                  {flags[k] && <span className="ms" style={{ fontSize: 14, marginRight: 4, verticalAlign: 'middle' }}>check</span>}
                  {label}
                </button>
              ))}
          </div>

          <button onClick={apply} disabled={applying}
            style={{ width: '100%', height: 44, borderRadius: 10, border: 'none', background: 'var(--accent)', color: '#fff', fontSize: 14, fontWeight: 600, cursor: applying ? 'not-allowed' : 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, opacity: applying ? 0.6 : 1 }}>
            <span className={`ms ${applying ? 'spin' : ''}`} style={{ fontSize: 18 }}>{applying ? 'progress_activity' : 'download_done'}</span>
            {applying ? 'Đang cập nhật...' : 'Cập nhật metadata'}
          </button>
        </div>
      )}
    </Modal>
  )
}
