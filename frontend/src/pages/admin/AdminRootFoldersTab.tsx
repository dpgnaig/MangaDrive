import { useEffect, useState, useRef } from 'react'
import { Button, Modal, Input, message, Popconfirm, Dropdown, Checkbox } from 'antd'
import * as signalR from '@microsoft/signalr'
import api from '../../lib/api'
import { useIsDesktop } from '../../hooks/useBreakpoint'
import { AdminSourcesSkeleton } from '../../components/Skeleton'
import type { RootFolder, MangaChild, SyncProgress, ScanResult } from './sourceTypes'
// Desktop and mobile share one render tree: a checkbox-select root list and a
// checkbox-select folder-detail drilldown, each with exactly one bulk "Đồng bộ
// (N)" action. isDesktop only tweaks spacing/type size, it no longer forks
// the JSX — the old per-row/per-screen sync buttons ("Đồng bộ tất cả",
// "Đồng bộ toàn bộ", per-row sync icon) were redundant with bulk sync and
// have been removed; syncing one item now means selecting it and hitting the
// bulk button, same as syncing everything (select-all + bulk).

export default function AdminRootFoldersTab({ showAddModal, onCloseAddModal }: { showAddModal?: boolean; onCloseAddModal?: () => void }) {
  const isDesktop = useIsDesktop()
  const [folders, setFolders] = useState<RootFolder[]>([])
  const [mangasByRoot, setMangasByRoot] = useState<Record<string, MangaChild[]>>({})
  const [progress, setProgress] = useState<Record<string, SyncProgress>>({})
  const [syncingMangas, setSyncingMangas] = useState<Set<string>>(new Set())
  const [scanResults, setScanResults] = useState<Record<string, ScanResult>>({})
  const [scanningRoots, setScanningRoots] = useState<Set<string>>(new Set())
  // Tracks in-flight detect-new-chapters calls per root, and whether the last
  // call for a root failed — surfaced on the root card so "checking" / "done,
  // nothing new" / "failed" are all visibly distinct instead of the silent
  // catch-and-ignore that used to make every one of those states look identical.
  const [detectingNewChapters, setDetectingNewChapters] = useState<Set<string>>(new Set())
  const [newChaptersError, setNewChaptersError] = useState<Set<string>>(new Set())
  const [showModal, setShowModal] = useState(false)
  const [loading, setLoading] = useState(true)
  const [openRootId, setOpenRootId] = useState<string | null>(null) // open root's folder-detail drilldown
  const [selectedRootIds, setSelectedRootIds] = useState<Set<string>>(new Set()) // root list multi-select
  const [selectedFolderKeys, setSelectedFolderKeys] = useState<Set<string>>(new Set()) // folder detail multi-select

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

      // Detect new chapters in background. Always replace this root's map (even
      // with an empty one) — otherwise a manga whose new-chapter count just
      // dropped to 0 (fully synced) keeps showing its last non-zero badge
      // forever, since a stale entry would never get overwritten.
      setDetectingNewChapters(prev => new Set(prev).add(root.id))
      setNewChaptersError(prev => { const s = new Set(prev); s.delete(root.id); return s })
      api.get(`/admin/root-folders/${root.id}/detect-new-chapters`)
        .then(({ data }) => {
          const map: Record<string, number> = {}
          for (const m of data.mangas) map[m.id] = m.newCount
          setNewChapters(prev => ({ ...prev, [root.id]: map }))
        })
        .catch(() => setNewChaptersError(prev => new Set(prev).add(root.id)))
        .finally(() => setDetectingNewChapters(prev => { const s = new Set(prev); s.delete(root.id); return s }))
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

  // Bulk sync: selected roots sync whole-root.
  const bulkSyncRoots = async () => {
    const ids = Array.from(selectedRootIds)
    try {
      for (const id of ids) await syncRoot(id)
      message.success('Đã bắt đầu đồng bộ các mục đã chọn')
      setSelectedRootIds(new Set())
    } catch { message.error('Đồng bộ thất bại') }
  }

  // Bulk sync (folder detail view): selected folders sync just that manga;
  // unsynced folders sync via sync-folder instead. Selected orphans have no
  // sync action and are skipped (orphans aren't selectable — no checkbox).
  const bulkSyncFolders = async (rootId: string) => {
    const scan = scanResults[rootId]
    if (!scan) return
    const keys = Array.from(selectedFolderKeys)
    try {
      for (const key of keys) {
        const sf = scan.folders.find(x => x.driveFileId === key)
        if (!sf) continue
        if (sf.synced && sf.mangaId) await syncManga(sf.mangaId, sf.mangaTitle || sf.name)
        else await syncSingleFromScan(rootId, sf.driveFileId, sf.name)
      }
      message.success('Đã bắt đầu đồng bộ các mục đã chọn')
      setSelectedFolderKeys(new Set())
    } catch { message.error('Đồng bộ thất bại') }
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

  const allRootsSelected = folders.length > 0 && folders.every(f => selectedRootIds.has(f.id))

  const rootToolbar = (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
      {folders.length > 0 && (
        <>
          <Checkbox
            checked={allRootsSelected}
            indeterminate={!allRootsSelected && selectedRootIds.size > 0}
            onChange={e => setSelectedRootIds(e.target.checked ? new Set(folders.map(f => f.id)) : new Set())}
          />
          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
            {selectedRootIds.size > 0 ? `${selectedRootIds.size} đã chọn` : 'Chọn tất cả'}
          </span>
        </>
      )}
      <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
        {selectedRootIds.size > 0 && (
          <Button type="primary" onClick={bulkSyncRoots} style={{ borderRadius: 20, height: 36 }}>
            <span className="ms ms-sm">sync</span> Đồng bộ
          </Button>
        )}
        <Button type="primary" onClick={() => setShowModal(true)} style={{ borderRadius: 20, height: 36 }}>
          <span className="ms ms-sm">add</span> Thêm
        </Button>
      </div>
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

  // ===== Folder detail: drilldown into a root's Drive subfolders =====
  if (openRootId) {
    const f = folders.find(x => x.id === openRootId)
    if (!f) { setOpenRootId(null); return null }
    const scan = scanResults[f.id]
    const isScanning = scanningRoots.has(f.id)
    const syncing = progress[f.id]?.status === 'Running'
    const children = mangasByRoot[f.id] || []
    const selectableKeys = scan ? scan.folders.map(sf => sf.driveFileId) : []
    const allSelected = selectableKeys.length > 0 && selectableKeys.every(k => selectedFolderKeys.has(k))
    const toggleFolderKey = (key: string) => {
      setSelectedFolderKeys(prev => {
        const s = new Set(prev)
        if (s.has(key)) s.delete(key); else s.add(key)
        return s
      })
    }

    return (
      <>
        {/* Detail header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
          <button className="icon-btn icon-btn-sm" onClick={() => { setOpenRootId(null); setSelectedFolderKeys(new Set()) }}><span className="ms">arrow_back</span></button>
          <span className="ms" style={{ fontSize: 20, color: 'var(--accent)' }}>folder</span>
          <span style={{ fontWeight: 600, fontSize: isDesktop ? 16 : 15, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.name}</span>
        </div>

        {selectableKeys.length > 0 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
            <Checkbox
              checked={allSelected}
              indeterminate={!allSelected && selectedFolderKeys.size > 0}
              onChange={e => setSelectedFolderKeys(e.target.checked ? new Set(selectableKeys) : new Set())}
            />
            <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
              {selectedFolderKeys.size > 0 ? `${selectedFolderKeys.size} đã chọn` : 'Chọn tất cả'}
            </span>
            <Button type="primary" disabled={selectedFolderKeys.size === 0} onClick={() => bulkSyncFolders(f.id)} style={{ borderRadius: 20, height: 36, marginLeft: 'auto' }}>
              <span className="ms ms-sm">sync</span> Đồng bộ{selectedFolderKeys.size > 0 ? ` (${selectedFolderKeys.size})` : ''}
            </Button>
          </div>
        )}

        {/* detect-new-chapters resolves every manga in this root in ONE request —
            there's no real per-folder progress, so a single status line here (not a
            spinner repeated on every row) is what actually matches how the check runs.
            Once resolved, per-row "+N mới" badges below carry the real per-manga info;
            this line only needs to speak up while in flight or if the whole check failed. */}
        {detectingNewChapters.has(f.id) ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 12, fontSize: 12, color: 'var(--text-muted)' }}>
            <span className="ms spin" style={{ fontSize: 15 }}>progress_activity</span>Đang kiểm tra chapter mới...
          </div>
        ) : newChaptersError.has(f.id) ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 12, fontSize: 12, color: 'var(--red)' }}>
            <span className="ms" style={{ fontSize: 15 }}>error</span>Không kiểm tra được chapter mới cho source này
          </div>
        ) : null}

        {!scan && isScanning ? (
          <div style={{ padding: 30, textAlign: 'center' }}>
            <span className="ms spin" style={{ fontSize: 24, color: 'var(--accent)' }}>progress_activity</span>
            <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 8 }}>Đang quét Drive...</p>
          </div>
        ) : scan ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {scan.folders.map(sf => {
              const manga = children.find(m => m.id === sf.mangaId)
              const newN = sf.mangaId ? newChapters[f.id]?.[sf.mangaId] : undefined
              // detect-new-chapters resolves every manga in the root in ONE request — there
              // is no real per-folder progress to show. The single status line above the
              // list already covers "checking"/"failed" for the whole root; a row only ever
              // decorates itself with the real, resolved "+N mới" count — never a fake
              // per-row spinner/error that would imply folders are being checked one by one.
              const foundNew = sf.synced && !detectingNewChapters.has(f.id) && !newChaptersError.has(f.id) && (newN ?? 0) > 0
              return (
                <div key={sf.driveFileId} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: isDesktop ? '10px 14px' : '12px 14px', background: 'var(--bg-elevated)', borderRadius: 10, border: '1px solid var(--border)', opacity: manga?.isHidden ? 0.5 : 1 }}>
                  <Checkbox checked={selectedFolderKeys.has(sf.driveFileId)} onChange={() => toggleFolderKey(sf.driveFileId)} />
                  <span className="ms" style={{ fontSize: 18, color: sf.synced ? 'var(--green)' : 'var(--text-muted)' }}>{sf.synced ? 'check_circle' : 'folder'}</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <p style={{ fontSize: 13, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'flex', alignItems: 'center', gap: 6 }}>
                      {sf.synced ? sf.mangaTitle : sf.name}
                      {manga?.linkedMangaId && <span className="ms" style={{ fontSize: 14, color: 'var(--accent)' }} title="Linked">link</span>}
                      {foundNew && <span style={{ fontSize: 10, fontWeight: 700, background: 'var(--green)', color: '#fff', borderRadius: 10, padding: '1px 6px', flexShrink: 0 }}>+{newN} mới</span>}
                    </p>
                    <p style={{ fontSize: 11, color: sf.synced ? 'var(--text-muted)' : 'var(--accent)', marginTop: 2 }}>
                      {sf.synced ? 'Đã đồng bộ' : 'Mới — chưa đồng bộ'}
                    </p>
                  </div>
                  {sf.synced && sf.mangaId && (
                    <Dropdown menu={{ items: [
                      { key: 'vis', icon: <span className="ms" style={{ fontSize: 16 }}>{manga?.isHidden ? 'visibility' : 'visibility_off'}</span>, label: manga?.isHidden ? 'Hiện' : 'Ẩn', disabled: !!manga?.linkedMangaId, onClick: () => toggleVisibility(sf.mangaId!, f.id) },
                      { key: 'del', icon: <span className="ms" style={{ fontSize: 16, color: 'var(--red)' }}>delete</span>, label: <span style={{ color: 'var(--red)' }}>Xóa</span>, onClick: () => deleteManga(sf.mangaId!, f.id, sf.mangaTitle || sf.name) },
                    ] as any }} trigger={['click']} placement="bottomRight">
                      <button className="icon-btn icon-btn-sm" style={{ color: 'var(--text-secondary)' }}><span className="ms">more_vert</span></button>
                    </Dropdown>
                  )}
                </div>
              )
            })}
            {scan.orphans && scan.orphans.length > 0 && (
              <>
                <p style={{ fontSize: 11, fontWeight: 600, color: 'var(--red)', textTransform: 'uppercase', letterSpacing: '0.05em', margin: '8px 4px 0' }}>Không còn trên Drive ({scan.orphans.length})</p>
                {scan.orphans.map(o => (
                  <div key={o.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: isDesktop ? '10px 14px' : '12px 14px', background: 'rgba(255,59,59,0.06)', borderRadius: 10, border: '1px solid var(--border)' }}>
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

  // ===== Root list =====

  return (
    <>
      {rootToolbar}

      <div style={{ display: 'flex', flexDirection: 'column', gap: isDesktop ? 10 : 12 }}>
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
          const checked = selectedRootIds.has(f.id)
          const checkingNew = detectingNewChapters.has(f.id)
          const newError = newChaptersError.has(f.id)
          const totalNewInRoot = Object.values(newChapters[f.id] || {}).reduce((a, b) => a + b, 0)

          return (
            <div key={f.id} style={{ background: 'var(--bg-elevated)', border: `1px solid ${f.isPublic ? 'rgba(0,200,83,0.3)' : 'var(--border)'}`, borderRadius: 12, overflow: 'hidden' }}>
              <div style={{ padding: isDesktop ? '12px 16px' : '14px 16px', display: 'flex', alignItems: 'center', gap: 10 }}>
                <Checkbox checked={checked} onChange={() => setSelectedRootIds(prev => { const s = new Set(prev); if (s.has(f.id)) s.delete(f.id); else s.add(f.id); return s })} />
                <button onClick={() => { setOpenRootId(f.id); setSelectedFolderKeys(new Set()); if (!scanResults[f.id]) scanFolder(f.id) }}
                  style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, display: 'flex', alignItems: 'center', gap: 10, flex: 1, minWidth: 0, textAlign: 'left' }}>
                  <span className="ms" style={{ fontSize: 20, color: 'var(--accent)', flexShrink: 0 }}>folder</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                      <span style={{ fontWeight: 600, fontSize: 14, color: 'var(--text)' }}>{f.name}</span>
                      {f.isPublic && <span style={{ fontSize: 10, color: 'var(--green)', fontWeight: 600 }}>Public</span>}
                      {isScanning && <span className="ms spin" style={{ fontSize: 14, color: 'var(--text-muted)' }}>progress_activity</span>}
                      {scan && (
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10, fontSize: 12, color: 'var(--text-muted)' }}>
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}><span className="ms" style={{ fontSize: 14 }}>folder</span>{scan.total}</span>
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, color: 'var(--green)' }}><span className="ms" style={{ fontSize: 14 }}>check_circle</span>{scan.synced}</span>
                          {scan.notSynced > 0 && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, color: 'var(--accent)' }}><span className="ms" style={{ fontSize: 14 }}>pending</span>{scan.notSynced}</span>}
                          {scan.orphanCount > 0 && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, color: 'var(--red)' }}><span className="ms" style={{ fontSize: 14 }}>warning</span>{scan.orphanCount}</span>}
                        </span>
                      )}
                      {/* Chapter-mới detection status — compact icon-only so it never wraps
                          onto its own line on mobile. "none" (the common, expected case) shows
                          nothing; checking/error/found get a small icon with the full label
                          available via title (hover on desktop, tap-and-hold on mobile). */}
                      {detectingNewChapters.has(f.id) ? (
                        <span className="ms spin" title="Đang kiểm tra chapter mới..." style={{ fontSize: 14, color: 'var(--text-muted)' }}>progress_activity</span>
                      ) : newChaptersError.has(f.id) ? (
                        <span className="ms" title="Kiểm tra chapter mới thất bại" style={{ fontSize: 14, color: 'var(--red)' }}>error</span>
                      ) : totalNewInRoot > 0 ? (
                        <span title={`+${totalNewInRoot} chapter mới`} style={{ display: 'inline-flex', alignItems: 'center', gap: 2, fontSize: 10, fontWeight: 700, color: '#fff', background: 'var(--green)', borderRadius: 10, padding: '1px 6px', flexShrink: 0 }}>
                          <span className="ms" style={{ fontSize: 12 }}>new_releases</span>{totalNewInRoot}
                        </span>
                      ) : null}
                    </div>
                    <span style={{ fontSize: 11, color: 'var(--accent)', fontFamily: 'monospace', marginTop: 6, background: 'var(--accent-subtle)', padding: '2px 8px', borderRadius: 4, display: 'inline-block' }}>{f.googleDriveFolderId}</span>
                  </div>
                  <span className="ms" style={{ fontSize: 20, color: 'var(--text-muted)', flexShrink: 0 }}>chevron_right</span>
                </button>

                {!f.isAutoAdded && (
                  <button className="icon-btn icon-btn-sm" onClick={() => del(f.id)} style={{ color: 'var(--red)' }} title="Xóa">
                    <span className="ms">delete</span>
                  </button>
                )}
              </div>

              {/* Sync progress */}
              {syncing && p && (
                <div style={{ padding: '0 16px 12px', marginLeft: isDesktop ? 44 : 30 }}>
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
