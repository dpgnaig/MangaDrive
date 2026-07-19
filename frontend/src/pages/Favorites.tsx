import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import api from '../lib/api'
import { imgUrl } from '../lib/img'
import AppLayout from '../components/AppLayout'
import { FavoritesSkeleton } from '../components/Skeleton'

interface FavManga { id: string; title: string; coverImageFileId: string; chapterCount: number }

export default function Favorites() {
  const [favorites, setFavorites] = useState<FavManga[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    api.get('/favorites').then(r => setFavorites(r.data)).catch(() => {}).finally(() => setLoading(false))
  }, [])

  return (
    <AppLayout showSearch={false}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}>
        <span className="ms" style={{ color: 'var(--red)' }}>favorite</span>
        <h2 style={{ fontSize: 16, fontWeight: 600 }}>Yêu thích</h2>
        <span style={{ fontSize: 13, color: 'var(--text-muted)', marginLeft: 4 }}>({favorites.length})</span>
      </div>

      {loading ? (
        <FavoritesSkeleton />
      ) : favorites.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '60px 20px' }}>
          <span className="ms" style={{ fontSize: 48, color: 'var(--text-muted)', display: 'block', marginBottom: 12 }}>favorite_border</span>
          <p style={{ fontSize: 14, color: 'var(--text-muted)' }}>Chưa có manga yêu thích</p>
          <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>Nhấn ♥ trên trang chi tiết manga để thêm vào yêu thích</p>
        </div>
      ) : (
        <div className="manga-grid">
          {favorites.map(m => (
            <Link key={m.id} to={`/manga/${m.id}`}>
              <div className="manga-card">
                <div style={{ aspectRatio: '2/3', background: 'var(--bg-hover)', position: 'relative' }}>
                  {m.coverImageFileId
                    ? <img src={imgUrl(m.coverImageFileId)} alt={m.title} style={{ width: '100%', height: '100%', objectFit: 'cover' }} loading="lazy" />
                    : <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><span className="ms" style={{ fontSize: 40, color: 'var(--text-muted)' }}>auto_stories</span></div>}
                  <div style={{ position: 'absolute', top: 6, right: 6, width: 24, height: 24, borderRadius: '50%', background: 'rgba(255,59,59,0.9)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <span className="ms" style={{ fontSize: 14, color: '#fff' }}>favorite</span>
                  </div>
                  <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, padding: '24px 8px 8px', background: 'linear-gradient(0deg, rgba(0,0,0,0.85) 0%, transparent 100%)' }}>
                    <p style={{ fontSize: 12, fontWeight: 600, color: '#fff', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textShadow: '0 1px 3px rgba(0,0,0,0.8)' }}>{m.title}</p>
                  </div>
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}
    </AppLayout>
  )
}
