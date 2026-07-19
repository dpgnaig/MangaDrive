import { useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import api from '../lib/api'
import { imgUrl } from '../lib/img'
import AppLayout from '../components/AppLayout'
import { LibrarySkeleton } from '../components/Skeleton'

interface FavManga { id: string; title: string; coverImageFileId: string; chapterCount: number }
interface ContinueItem { mangaId: string; title: string; coverImageFileId: string; chapterId: string; chapterName: string }
interface HistoryItem { id: string; title: string; coverImageFileId: string; chapterId: string; chapterName: string; updatedAt: string }

export default function Library() {
  const [searchParams, setSearchParams] = useSearchParams()
  const tab = (searchParams.get('tab') || 'continue') as 'continue' | 'favorites' | 'history'
  const setTab = (t: string) => setSearchParams({ tab: t })
  const [favorites, setFavorites] = useState<FavManga[]>([])
  const [continueList, setContinueList] = useState<ContinueItem[]>([])
  const [history, setHistory] = useState<HistoryItem[]>([])
  const [loading, setLoading] = useState(true)

  const clearHistory = async () => {
    try { await api.post('/reading-history/clear'); setHistory([]); setContinueList([]) } catch (e) { console.error(e) }
  }

  useEffect(() => {
    setLoading(true)
    Promise.all([
      api.get('/favorites').then(r => setFavorites(r.data)),
      api.get('/continue-reading').then(r => setContinueList(r.data)),
      api.get('/reading-history').then(r => setHistory(r.data)),
    ]).finally(() => setLoading(false))
  }, [])

  const tabs = [
    { key: 'continue', icon: 'play_circle', label: 'Đọc tiếp' },
    { key: 'favorites', icon: 'favorite', label: 'Yêu thích' },
    { key: 'history', icon: 'history', label: 'Lịch sử' },
  ] as const

  return (
    <AppLayout showSearch={false}>
      {loading ? <LibrarySkeleton /> : (<>
      <div style={{ display: 'flex', gap: 6, marginBottom: 16 }}>
        {tabs.map(t => (
          <button key={t.key} onClick={() => setTab(t.key)}
            style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 14px', borderRadius: 20, border: 'none', background: tab === t.key ? 'var(--accent)' : 'var(--bg-elevated)', color: tab === t.key ? '#fff' : 'var(--text-secondary)', fontSize: 13, fontWeight: 500, cursor: 'pointer', transition: 'all 0.2s' }}>
            <span className="ms" style={{ fontSize: 16 }}>{t.icon}</span>{t.label}
          </button>
        ))}
      </div>
        {tab === 'continue' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {continueList.length === 0 && <p style={{ color: 'var(--text-muted)', textAlign: 'center', padding: 32 }}>Chưa có manga nào đang đọc</p>}
            {continueList.map(c => (
              <Link key={c.chapterId} to={`/chapter/${c.chapterId}`}>
                <div style={{ display: 'flex', gap: 12, padding: 12, background: 'var(--bg-elevated)', borderRadius: 12, alignItems: 'center' }}>
                  <div style={{ width: 48, height: 64, borderRadius: 6, overflow: 'hidden', flexShrink: 0, background: 'var(--bg-hover)' }}>
                    {c.coverImageFileId && <img src={imgUrl(c.coverImageFileId)} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />}
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <p style={{ fontSize: 14, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.title}</p>
                    <p style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 4 }}>{c.chapterName}</p>
                  </div>
                  <span className="ms" style={{ color: 'var(--accent)' }}>play_arrow</span>
                </div>
              </Link>
            ))}
          </div>
        )}

        {tab === 'favorites' && (
          <div className="manga-grid">
            {favorites.length === 0 && <p style={{ color: 'var(--text-muted)', textAlign: 'center', padding: 32, gridColumn: '1/-1' }}>Chưa có manga yêu thích</p>}
            {favorites.map(m => (
              <Link key={m.id} to={`/manga/${m.id}`}>
                <div className="manga-card">
                  <div style={{ aspectRatio: '2/3', background: 'var(--bg-hover)', position: 'relative' }}>
                    {m.coverImageFileId && <img src={imgUrl(m.coverImageFileId)} style={{ width: '100%', height: '100%', objectFit: 'cover' }} loading="lazy" />}
                    <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, padding: '20px 8px 8px', background: 'linear-gradient(0deg, rgba(0,0,0,0.85) 0%, transparent 100%)' }}>
                      <p style={{ fontSize: 12, fontWeight: 600, color: '#fff', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.title}</p>
                    </div>
                  </div>
                </div>
              </Link>
            ))}
          </div>
        )}

        {tab === 'history' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {history.length > 0 && (
              <button onClick={clearHistory}
                style={{ alignSelf: 'flex-end', background: 'none', border: '1px solid var(--border)', borderRadius: 8, padding: '6px 14px', color: 'var(--red)', fontSize: 12, fontWeight: 500, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6 }}>
                <span className="ms" style={{ fontSize: 16 }}>delete_sweep</span>Xóa lịch sử
              </button>
            )}
            {history.length === 0 && <p style={{ color: 'var(--text-muted)', textAlign: 'center', padding: 32 }}>Chưa có lịch sử đọc</p>}
            {history.map(h => (
              <Link key={h.chapterId} to={`/chapter/${h.chapterId}`}>
                <div style={{ display: 'flex', gap: 12, padding: 10, background: 'var(--bg-elevated)', borderRadius: 10, alignItems: 'center' }}>
                  <div style={{ width: 40, height: 54, borderRadius: 6, overflow: 'hidden', flexShrink: 0, background: 'var(--bg-hover)' }}>
                    {h.coverImageFileId && <img src={imgUrl(h.coverImageFileId)} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />}
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <p style={{ fontSize: 13, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{h.title}</p>
                    <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>{h.chapterName}</p>
                  </div>
                  <span style={{ fontSize: 11, color: 'var(--text-muted)', flexShrink: 0 }}>{new Date(h.updatedAt).toLocaleDateString()}</span>
                </div>
              </Link>
            ))}
          </div>
        )}
      </>)}
    </AppLayout>
  )
}
