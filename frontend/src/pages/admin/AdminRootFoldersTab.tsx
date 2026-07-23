import { useEffect, useState, useRef } from 'react'
import { Button, Modal, Input, message, Popconfirm, Dropdown } from 'antd'
import * as signalR from '@microsoft/signalr'
import api from '../../lib/api'
import { useIsDesktop } from '../../hooks/useBreakpoint'
import { AdminSourcesSkeleton } from '../../components/Skeleton'
import AdminSourcesTable from './AdminSourcesTable'
import type { RootFolder, MangaChild, SyncProgress, ScanResult } from './sourceTypes'

export default function AdminRootFoldersTab({ showAddModal, onCloseAddModal }: { showAddModal?: boolean; onCloseAddModal?: () => void }) {
  const isDesktop = useIsDesktop()
  const [folders, setFolders] = useState<RootFolder[]>([])
  const [mangasByRoot, setMangasByRoot] = useState<Record<string, MangaChild[]>>({})
  const [progress, setProgress] = useState<Record<string, SyncProgress>>({})
  const [syncingMangas, setSyncingMangas] = useState<Set<string>>(new Set())
  const [scanResults, setScanResults] = useState<Record<string, ScanResult>>({})
  const [scanningRoots, setScanningRoots] = useState<Set<string>>(new Set())
  const [showModal, setShowModal] = useState(false)
  const [loading, setLoading] = useState(true)
  const [mobileRootId, setMobileRootId] = useState<string | null>(null) // mobile: open root's detail

  useEffect(() => {
    if (showAddModal) setShowModal(true)
  }, [showAddModal])
  const [name, setName] = useState('')
  const [folderId, setFolderId] = useState('')
  const [newChapters, setNewChapters] = useState<Record<string, Record<string, number>>>({}) // rootId -> { mangaId: count }
  const scanResultsRef = useRef<Record<string, ScanResult>>({})
  // Kept in sync with syncingMangas so the SignalR handler (registered once,
  // closes over stale state otherwise) can check/clear the right manga ids.
  const syncingMangasRef = useRef<Set<string>>(new Set())

  // Keep ref in sync with state for use in SignalR handler
  useEffect(() => { scanResultsRef.current = scanResults }, [scanResults])
  useEffect(() => { syncingMangasRef.current = syncingMangas }, [syncingMangas])

  useEffect(() => { load() }, [])

  useEffect(() => {
    const conn = new signalR.HubConnectionBuilder()
      .withUrl(`/hubs/sync`, { accessTokenFactory: () => localStorage.getItem('token') || '' })
      .withAutomaticReconnect().build()
    conn.start()
    conn.on('SyncProgress', (p: SyncProgress) => {
      setProgress(prev => ({ ...prev, [p.rootFolderId]: p }))

      // Update newChapters badge in real-time
      if (p.currentManga && p.currentMangaNewChapters > 0) {
        const scan = scanResultsRef.current[p.rootFolderId]
        if (scan) {
          const folder = scan.folders.find(f => f.mangaTitle === p.currentManga || f.name === p.currentManga)
          if (folder?.mangaId) {
            setNewChapters(prev => ({
              ...prev,
              [p.rootFolderId]: {
                ...(prev[p.rootFolderId] || {}),
                [folder.mangaId!]: p.currentMangaNewChapters
              }
            }))
          }
        }
      }

      if (p.status === 'Completed' || p.status === 'Failed') {
        // A single-manga sync (syncManga) tracks its own spinner via
        // syncingMangas, keyed by manga id — clear it as soon as the job that
        // touched this manga actually finishes, instead of a fixed timeout
        // that's decoupled from real progress (see syncManga below).
        if (p.currentMangaId && syncingMangasRef.current.has(p.currentMangaId)) {
          setSyncingMangas(prev => { const s = new Set(prev); s.delete(p.currentMangaId!); return s })
        }
        if (p.status === 'Failed') {
          message.error(`Đồng bộ "${p.currentManga || p.rootName}" thất bại: ${p.message}`)
        } else {
          // Reload to pick up any auto-link or chapter changes
          setTimeout(() => load(), 1000)
        }
      }
    })
    return () => { conn.stop() }
  }, [])

  const load = async () => {
    const { data: roots } = await api.get('/admin/root-folders')
    setFolders(roots)
    const { data: mangas } = await api.get('/admin/mangas')
    const grouped: Record<string, MangaChild[]> = {}
    for (const root of roots) grouped[root.id] = []
    for (const m of mangas) {
      if (grouped[m.rootFolderId]) {
        grouped[m.rootFolderId].push({ id: m.id, title: m.title, isHidden: m.isHidden, linkedMangaId: m.linkedMangaId || null })
      }
    }
    setMangasByRoot(grouped)
    setLoading(false)

    // Auto-scan all root folders on load
    for (const root of roots) {
      setScanningRoots(prev => new Set(prev).add(root.id))
      api.get(`/admin/root-folders/${root.id}/scan`)
        .then(({ data }) => setScanResults(prev => ({ ...prev, [root.id]: data })))
        .catch(() => { /* ignore */ })
        .finally(() => setScanningRoots(prev => { const s = new Set(prev); s.delete(root.id); return s }))

      // Detect new chapters in background
      api.get(`/admin/root-folders/${root.id}/detect-new-chapters`)
        .then(({ data }) => {
          if (data.totalNew > 0) {
            const map: Record<string, number> = {}
            for (const m of data.mangas) map[m.id] = m.newCount
            setNewChapters(prev => ({ ...prev, [root.id]: map }))
          }
        })
        .catch(() => { /* ignore */ })
    }
  }

  const scanFolder = async (rootId: string) => {
    setScanningRoots(prev => new Set(prev).add(rootId))
    try {
      const { data } = await api.get(`/admin/root-folders/${rootId}/scan`)
      setScanResults(prev => ({ ...prev, [rootId]: data }))
    } catch { /* ignore */ }
    setScanningRoots(prev => { const s = new Set(prev); s.delete(rootId); return s })
  }

  const syncRoot = (id: string) => api.post(`/admin/root-folders/${id}/sync`)

  const syncAll = async () => {
    for (const f of folders) {
      await api.post(`/admin/root-folders/${f.id}/sync`)
    }
    message.success('Đang đồng bộ tất cả sources')
  }
  const syncManga = async (id: string, title: string) => {
    setSyncingMangas(prev => new Set(prev).add(id))
    try {
      await api.post(`/admin/mangas/${id}/sync`)
      message.success(`Đang sync "${title}"`)
    } catch {
      message.error('Sync thất bại')
      setSyncingMangas(prev => { const s = new Set(prev); s.delete(id); return s })
    }
    // No timeout here — the SignalR handler above clears this manga's spinner
    // (and reloads on success / toasts on failure) once the real job for it
    // reports Completed/Failed via currentMangaId, so it can't clear early
    // while the job is still running or hang forever if the job crashes.
  }
  const syncSingleFromScan = async (rootId: string, driveFileId: string, folderName: string) => {
    try {
      await api.post(`/admin/root-folders/${rootId}/sync-folder`, { driveFileId, name: folderName })
      message.success(`Đang sync "${folderName}"`)
      setScanResults(prev => prev[rootId] ? { ...prev, [rootId]: { ...prev[rootId], folders: prev[rootId].folders.map(f => f.driveFileId === driveFileId ? { ...f, synced: true } : f), notSynced: prev[rootId].notSynced - 1, synced: prev[rootId].synced + 1 } } : prev)
      setTimeout(() => load(), 2000)
    } catch { message.error('Thất bại') }
  }
  const syncNewOnly = async (rootId: string) => {
    try {
      const { data } = await api.post(`/admin/root-folders/${rootId}/sync-new`)
      message.success(data.message)
      setTimeout(() => { load(); scanFolder(rootId) }, 2000)
    } catch { message.error('Thất bại') }
  }

  const del = async (id: string) => { await api.delete(`/admin/root-folders/${id}`); load() }

  const deleteManga = async (mangaId: string, rootId: string, title: string) => {
    try {
      await api.delete(`/admin/mangas/${mangaId}`)
      message.success(`Đã xóa "${title}"`)
      setMangasByRoot(prev => ({ ...prev, [rootId]: prev[rootId].filter(m => m.id !== mangaId) }))
      setScanResults(prev => {
        const scan = prev[rootId]
        if (!scan) return prev
        // Deleted manga may be a synced folder (still on Drive — revert that row back
        // to "chưa đồng bộ" instead of removing it) or an orphan (already gone from
        // Drive, only existed as a DB row — remove it outright, nothing to revert to).
        const wasOrphan = scan.orphans.some(o => o.id === mangaId)
        return {
          ...prev,
          [rootId]: {
            ...scan,
            folders: scan.folders.map(f => f.mangaId === mangaId ? { ...f, synced: false, mangaId: null, mangaTitle: null, lastSynced: null } : f),
            orphans: scan.orphans.filter(o => o.id !== mangaId),
            synced: wasOrphan ? scan.synced : scan.synced - 1,
            notSynced: wasOrphan ? scan.notSynced : scan.notSynced + 1,
            orphanCount: wasOrphan ? scan.orphanCount - 1 : scan.orphanCount,
          }
        }
      })
    } catch { message.error('Xóa thất bại') }
  }

  const toggleVisibility = async (mangaId: string, rootId: string) => {
    const { data } = await api.post(`/admin/mangas/${mangaId}/toggle-visibility`)
    setMangasByRoot(prev => ({
      ...prev,
      [rootId]: prev[rootId].map(m => m.id === mangaId ? { ...m, isHidden: data.isHidden } : m)
    }))
  }

  const createFromForm = async () => {
    if (!name.trim() || !folderId.trim()) return
    await api.post('/admin/root-folders', { name: name.trim(), googleDriveFolderId: folderId.trim(), isPublic: true })
    setShowModal(false); setName(''); setFolderId(''); load()
  }

  if (loading) return <AdminSourcesSkeleton />

  const toolbar = (
    <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginBottom: 16 }}>
      <Button onClick={syncAll} style={{ borderRadius: 20, height: 36 }}>
        <span className="ms ms-sm">sync</span> Đồng bộ tất cả
      </Button>
      <Button type="primary" onClick={() => setShowModal(true)} style={{ borderRadius: 20, height: 36 }}>
        <span className="ms ms-sm">add</span> Thêm
      </Button>
    </div>
  )

  const addModal = (
    <Modal open={showModal} onCancel={() => { setShowModal(false); onCloseAddModal?.() }} title="Thêm Drive Source" onOk={createFromForm} okText="Thêm" cancelText="Hủy" centered>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16, paddingTop: 8 }}>
        <div>
          <label style={{ fontSize: 13, fontWeight: 500, display: 'block', marginBottom: 6 }}>Tên</label>
          <Input value={name} onChange={e => setName(e.target.value)} placeholder="VD: Shounen Collection" />
        </div>
        <div>
          <label style={{ fontSize: 13, fontWeight: 500, display: 'block', marginBottom: 6 }}>Google Drive Folder ID</label>
          <Input value={folderId} onChange={e => setFolderId(e.target.value)} placeholder="Paste folder ID" style={{ fontFamily: 'monospace' }} />
        </div>
      </div>
    </Modal>
  )

  // ===== Desktop: antd tree table with row-selection bulk sync =====
  if (isDesktop) {
    return (
      <>
        {toolbar}
        {folders.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '40px 20px', background: 'var(--bg-elevated)', borderRadius: 12, border: '1px solid var(--border)' }}>
            <span className="ms" style={{ fontSize: 40, color: 'var(--text-muted)', marginBottom: 8, display: 'block' }}>folder_off</span>
            <p style={{ fontSize: 14, color: 'var(--text-muted)' }}>Chưa có source nào được thêm</p>
          </div>
        ) : (
          <AdminSourcesTable
            folders={folders}
            mangasByRoot={mangasByRoot}
            scanResults={scanResults}
            scanningRoots={scanningRoots}
            syncingMangas={syncingMangas}
            progress={progress}
            newChapters={newChapters}
            onExpandRoot={scanFolder}
            syncRoot={syncRoot}
            syncManga={syncManga}
            syncSingleFromScan={syncSingleFromScan}
            toggleVisibility={toggleVisibility}
            deleteManga={deleteManga}
            del={del}
          />
        )}
        {addModal}
      </>
    )
  }

  // ===== Mobile: root card list, tap through to a detail view =====
  if (mobileRootId) {
    const f = folders.find(x => x.id === mobileRootId)
    if (!f) { setMobileRootId(null); return null }
    const scan = scanResults[f.id]
    const isScanning = scanningRoots.has(f.id)
    const syncing = progress[f.id]?.status === 'Running'
    const children = mangasByRoot[f.id] || []
    return (
      <>
        {/* Detail header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
          <button className="icon-btn icon-btn-sm" onClick={() => setMobileRootId(null)}><span className="ms">arrow_back</span></button>
          <span className="ms" style={{ fontSize: 20, color: 'var(--accent)' }}>folder</span>
          <span style={{ fontWeight: 600, fontSize: 15, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.name}</span>
          <button className="icon-btn icon-btn-sm" onClick={() => syncRoot(f.id)} disabled={syncing} title="Đồng bộ toàn bộ" style={{ color: syncing ? 'var(--text-muted)' : 'var(--green)' }}>
            <span className={`ms ${syncing ? 'spin' : ''}`}>{syncing ? 'progress_activity' : 'sync'}</span>
          </button>
        </div>

        {!scan && isScanning ? (
          <div style={{ padding: 30, textAlign: 'center' }}>
            <span className="ms spin" style={{ fontSize: 24, color: 'var(--accent)' }}>progress_activity</span>
            <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 8 }}>Đang quét Drive...</p>
          </div>
        ) : scan ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {scan.folders.map(sf => {
              const manga = children.find(m => m.id === sf.mangaId)
              const isSyncing = sf.mangaId ? syncingMangas.has(sf.mangaId) : false
              const newN = sf.mangaId ? newChapters[f.id]?.[sf.mangaId] : undefined
              return (
                <div key={sf.driveFileId} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 14px', background: 'var(--bg-elevated)', borderRadius: 10, border: '1px solid var(--border)', opacity: manga?.isHidden ? 0.5 : 1 }}>
                  <span className="ms" style={{ fontSize: 18, color: sf.synced ? 'var(--green)' : 'var(--text-muted)' }}>{sf.synced ? 'check_circle' : 'folder'}</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <p style={{ fontSize: 13, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'flex', alignItems: 'center', gap: 6 }}>
                      {sf.synced ? sf.mangaTitle : sf.name}
                      {manga?.linkedMangaId && <span className="ms" style={{ fontSize: 14, color: 'var(--accent)' }} title="Linked">link</span>}
                      {newN ? <span style={{ fontSize: 10, fontWeight: 700, background: 'var(--green)', color: '#fff', borderRadius: 10, padding: '1px 6px' }}>+{newN} mới</span> : null}
                    </p>
                    <p style={{ fontSize: 11, color: sf.synced ? 'var(--text-muted)' : 'var(--accent)', marginTop: 2 }}>{sf.synced ? 'Đã đồng bộ' : 'Mới — chưa đồng bộ'}</p>
                  </div>
                  {sf.synced && sf.mangaId ? (
                    <Dropdown menu={{ items: [
                      { key: 'sync', icon: <span className="ms" style={{ fontSize: 16 }}>sync</span>, label: 'Đồng bộ', disabled: syncing || isSyncing, onClick: () => syncManga(sf.mangaId!, sf.mangaTitle || sf.name) },
                      { key: 'vis', icon: <span className="ms" style={{ fontSize: 16 }}>{manga?.isHidden ? 'visibility' : 'visibility_off'}</span>, label: manga?.isHidden ? 'Hiện' : 'Ẩn', disabled: !!manga?.linkedMangaId, onClick: () => toggleVisibility(sf.mangaId!, f.id) },
                      { key: 'del', icon: <span className="ms" style={{ fontSize: 16, color: 'var(--red)' }}>delete</span>, label: <span style={{ color: 'var(--red)' }}>Xóa</span>, onClick: () => deleteManga(sf.mangaId!, f.id, sf.mangaTitle || sf.name) },
                    ] as any }} trigger={['click']} placement="bottomRight">
                      <button className="icon-btn icon-btn-sm" style={{ color: 'var(--text-secondary)' }}><span className="ms">more_vert</span></button>
                    </Dropdown>
                  ) : (
                    <button className="icon-btn icon-btn-sm" onClick={() => syncSingleFromScan(f.id, sf.driveFileId, sf.name)} disabled={syncing} title="Đồng bộ folder" style={{ color: syncing ? 'var(--text-muted)' : 'var(--green)' }}>
                      <span className="ms">sync</span>
                    </button>
                  )}
                </div>
              )
            })}
            {scan.orphans && scan.orphans.length > 0 && (
              <>
                <p style={{ fontSize: 11, fontWeight: 600, color: 'var(--red)', textTransform: 'uppercase', letterSpacing: '0.05em', margin: '8px 4px 0' }}>Không còn trên Drive ({scan.orphans.length})</p>
                {scan.orphans.map(o => (
                  <div key={o.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 14px', background: 'rgba(255,59,59,0.06)', borderRadius: 10, border: '1px solid var(--border)' }}>
                    <span className="ms" style={{ fontSize: 18, color: 'var(--red)' }}>error</span>
                    <p style={{ flex: 1, minWidth: 0, fontSize: 13, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{o.title}</p>
                    <Popconfirm title={`Xóa "${o.title}"?`} onConfirm={() => deleteManga(o.id, f.id, o.title)} okText="Xóa" cancelText="Hủy" okButtonProps={{ danger: true }}>
                      <button className="icon-btn icon-btn-sm" style={{ color: 'var(--red)' }}><span className="ms">delete</span></button>
                    </Popconfirm>
                  </div>
                ))}
              </>
            )}
          </div>
        ) : (
          <p style={{ fontSize: 13, color: 'var(--text-muted)', textAlign: 'center', padding: 20 }}>Không thể quét. Kiểm tra kết nối Drive.</p>
        )}
        {addModal}
      </>
    )
  }

  return (
    <>
      {toolbar}

      {/* Mobile root card list */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {folders.length === 0 && (
          <div style={{ textAlign: 'center', padding: '40px 20px', background: 'var(--bg-elevated)', borderRadius: 12, border: '1px solid var(--border)' }}>
            <span className="ms" style={{ fontSize: 40, color: 'var(--text-muted)', marginBottom: 8, display: 'block' }}>folder_off</span>
            <p style={{ fontSize: 14, color: 'var(--text-muted)' }}>Chưa có source nào được thêm</p>
          </div>
        )}
        {folders.map(f => {
          const syncing = progress[f.id]?.status === 'Running'
          const p = progress[f.id]
          const scan = scanResults[f.id]
          const isScanning = scanningRoots.has(f.id)

          return (
            <div key={f.id} style={{ background: 'var(--bg-elevated)', border: `1px solid ${f.isPublic ? 'rgba(0,200,83,0.3)' : 'var(--border)'}`, borderRadius: 12, overflow: 'hidden' }}>
              {/* Root folder card — tap body to open detail */}
              <div style={{ padding: '14px 16px', display: 'flex', alignItems: 'center', gap: 10 }}>
                <button onClick={() => { setMobileRootId(f.id); if (!scanResults[f.id]) scanFolder(f.id) }}
                  style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, display: 'flex', alignItems: 'center', gap: 10, flex: 1, minWidth: 0, textAlign: 'left' }}>
                  <span className="ms" style={{ fontSize: 20, color: 'var(--accent)', flexShrink: 0 }}>folder</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                      <span style={{ fontWeight: 600, fontSize: 14, color: 'var(--text)' }}>{f.name}</span>
                      {isScanning && <span className="ms spin" style={{ fontSize: 14, color: 'var(--text-muted)' }}>progress_activity</span>}
                      {scan && (
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10, fontSize: 12, color: 'var(--text-muted)' }}>
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}><span className="ms" style={{ fontSize: 14 }}>folder</span>{scan.total}</span>
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, color: 'var(--green)' }}><span className="ms" style={{ fontSize: 14 }}>check_circle</span>{scan.synced}</span>
                          {scan.notSynced > 0 && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, color: 'var(--accent)' }}><span className="ms" style={{ fontSize: 14 }}>pending</span>{scan.notSynced}</span>}
                          {scan.orphanCount > 0 && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, color: 'var(--red)' }}><span className="ms" style={{ fontSize: 14 }}>warning</span>{scan.orphanCount}</span>}
                        </span>
                      )}
                    </div>
                    <span style={{ fontSize: 11, color: 'var(--accent)', fontFamily: 'monospace', marginTop: 6, background: 'var(--accent-subtle)', padding: '2px 8px', borderRadius: 4, display: 'inline-block' }}>{f.googleDriveFolderId}</span>
                  </div>
                  <span className="ms" style={{ fontSize: 20, color: 'var(--text-muted)', flexShrink: 0 }}>chevron_right</span>
                </button>

                <button className="icon-btn icon-btn-sm" onClick={() => syncRoot(f.id)} disabled={syncing} title="Sync toàn bộ"
                  style={{ color: syncing ? 'var(--text-muted)' : 'var(--green)' }}>
                  <span className={`ms ${syncing ? 'spin' : ''}`}>{syncing ? 'progress_activity' : 'sync'}</span>
                </button>
                {!f.isAutoAdded && (
                  <button className="icon-btn icon-btn-sm" onClick={() => del(f.id)} style={{ color: 'var(--red)' }} title="Xóa">
                    <span className="ms">delete</span>
                  </button>
                )}
              </div>

              {/* Sync progress */}
              {syncing && p && (
                <div style={{ padding: '0 16px 12px', marginLeft: 30 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 6 }}>
                    <span style={{ fontSize: 12, color: 'var(--text-secondary)', flex: 1 }}>{p.message}</span>
                    <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--accent)' }}>{p.percent}%</span>
                  </div>
                  <div style={{ height: 5, borderRadius: 3, background: 'var(--bg-hover)', overflow: 'hidden' }}>
                    <div style={{ height: '100%', borderRadius: 3, background: 'var(--accent)', width: `${p.percent}%`, transition: 'width 0.3s' }} />
                  </div>
                  <div style={{ display: 'flex', gap: 16, marginTop: 8, fontSize: 11, color: 'var(--text-muted)', flexWrap: 'wrap' }}>
                    <span>Manga: {p.syncedManga}/{p.totalManga}</span>
                    <span>Chapter: {p.currentMangaSyncedChapter}/{p.currentMangaTotalChapter}</span>
                    {p.currentMangaNewChapters > 0 && (
                      <span style={{ color: 'var(--green)' }}>+{p.currentMangaNewChapters} mới</span>
                    )}
                    <span>Images: {p.syncedImage}/{p.totalImage}</span>
                  </div>
                </div>
              )}
            </div>
          )
        })}
      </div>

      {addModal}
    </>
  )
}


