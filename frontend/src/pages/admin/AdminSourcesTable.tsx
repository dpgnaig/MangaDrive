import { useState } from 'react'
import { Table, Button, Popconfirm, message } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import type { RootFolder, MangaChild, ScanResult, SyncProgress } from './sourceTypes'

interface Props {
  folders: RootFolder[]
  mangasByRoot: Record<string, MangaChild[]>
  scanResults: Record<string, ScanResult>
  scanningRoots: Set<string>
  syncingMangas: Set<string>
  progress: Record<string, SyncProgress>
  newChapters: Record<string, Record<string, number>>
  onExpandRoot: (rootId: string) => void
  syncRoot: (id: string) => Promise<unknown> | unknown
  syncManga: (id: string, title: string) => Promise<void>
  syncSingleFromScan: (rootId: string, driveFileId: string, name: string) => Promise<void>
  toggleVisibility: (mangaId: string, rootId: string) => void
  deleteManga: (mangaId: string, rootId: string, title: string) => void
  del: (id: string) => void
}

/** A single row in the tree table (root, drive folder, orphan, or a loading placeholder). */
interface Row {
  key: string
  kind: 'root' | 'folder' | 'orphan' | 'loading'
  name: string
  rootId: string
  root?: RootFolder
  folder?: ScanResult['folders'][number]
  orphan?: ScanResult['orphans'][number]
  children?: Row[]
}

export default function AdminSourcesTable({
  folders, mangasByRoot, scanResults, scanningRoots, syncingMangas, progress, newChapters,
  onExpandRoot, syncRoot, syncManga, syncSingleFromScan, toggleVisibility, deleteManga, del,
}: Props) {
  const [selectedRowKeys, setSelectedRowKeys] = useState<React.Key[]>([])
  const [dispatching, setDispatching] = useState(false)

  // Build tree: each root always has children (real rows, or a loading placeholder)
  // so the expand caret is available even before a scan has run.
  const buildChildren = (rootId: string): Row[] => {
    const scan = scanResults[rootId]
    if (!scan) {
      return [{ key: `loading:${rootId}`, kind: 'loading', name: '', rootId }]
    }
    const folderRows: Row[] = scan.folders.map(sf => ({
      key: `folder:${rootId}:${sf.driveFileId}`,
      kind: 'folder', name: sf.mangaTitle || sf.name, rootId, folder: sf,
    }))
    const orphanRows: Row[] = (scan.orphans || []).map(o => ({
      key: `orphan:${rootId}:${o.id}`,
      kind: 'orphan', name: o.title, rootId, orphan: o,
    }))
    const all = [...folderRows, ...orphanRows]
    return all.length ? all : [{ key: `empty:${rootId}`, kind: 'loading', name: '', rootId }]
  }

  const data: Row[] = folders.map(f => ({
    key: `root:${f.id}`, kind: 'root', name: f.name, rootId: f.id, root: f,
    children: buildChildren(f.id),
  }))

  // Bulk sync: selected roots sync whole-root; selected folders sync just that
  // manga (skip folders whose parent root is also selected).
  const syncSelected = async () => {
    const keys = selectedRowKeys.map(String)
    const selectedRoots = new Set(keys.filter(k => k.startsWith('root:')).map(k => k.slice(5)))
    setDispatching(true)
    try {
      for (const rid of selectedRoots) await syncRoot(rid)
      for (const key of keys) {
        if (!key.startsWith('folder:')) continue
        const [, rootId, driveFileId] = key.split(':')
        if (selectedRoots.has(rootId)) continue // covered by root sync
        const sf = scanResults[rootId]?.folders.find(x => x.driveFileId === driveFileId)
        if (!sf) continue
        if (sf.synced && sf.mangaId) await syncManga(sf.mangaId, sf.mangaTitle || sf.name)
        else await syncSingleFromScan(rootId, sf.driveFileId, sf.name)
      }
      message.success('Đã bắt đầu đồng bộ các mục đã chọn')
      setSelectedRowKeys([])
    } catch { message.error('Đồng bộ thất bại') }
    setDispatching(false)
  }

  const columns: ColumnsType<Row> = [
    {
      title: 'Tên', dataIndex: 'name', key: 'name',
      render: (_, row) => {
        if (row.kind === 'loading') {
          const scanning = scanningRoots.has(row.rootId)
          return <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
            {scanning ? <><span className="ms spin" style={{ fontSize: 14, verticalAlign: 'middle', marginRight: 6 }}>progress_activity</span>Đang quét Drive...</> : 'Không có thư mục'}
          </span>
        }
        if (row.kind === 'root') {
          const f = row.root!
          const scan = scanResults[f.id]
          return (
            <div style={{ minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <span className="ms" style={{ fontSize: 18, color: 'var(--accent)' }}>folder</span>
                <span style={{ fontWeight: 600 }}>{f.name}</span>
                {f.isPublic && <span style={{ fontSize: 10, color: 'var(--green)', fontWeight: 600 }}>Public</span>}
                {scanningRoots.has(f.id) && <span className="ms spin" style={{ fontSize: 14, color: 'var(--text-muted)' }}>progress_activity</span>}
                {scan && (
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10, fontSize: 12, color: 'var(--text-muted)' }}>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}><span className="ms" style={{ fontSize: 14 }}>folder</span>{scan.total}</span>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, color: 'var(--green)' }}><span className="ms" style={{ fontSize: 14 }}>check_circle</span>{scan.synced}</span>
                    {scan.notSynced > 0 && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, color: 'var(--accent)' }}><span className="ms" style={{ fontSize: 14 }}>pending</span>{scan.notSynced}</span>}
                    {scan.orphanCount > 0 && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, color: 'var(--red)' }}><span className="ms" style={{ fontSize: 14 }}>warning</span>{scan.orphanCount}</span>}
                  </span>
                )}
              </div>
              <span style={{ fontSize: 11, color: 'var(--accent)', fontFamily: 'monospace', background: 'var(--accent-subtle)', padding: '1px 8px', borderRadius: 4, display: 'inline-block', marginTop: 6 }}>{f.googleDriveFolderId}</span>
            </div>
          )
        }
        if (row.kind === 'orphan') {
          return (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span className="ms" style={{ fontSize: 16, color: 'var(--red)' }}>error</span>
              <span style={{ fontSize: 13 }}>{row.name}</span>
            </div>
          )
        }
        // folder
        const sf = row.folder!
        const manga = mangasByRoot[row.rootId]?.find(m => m.id === sf.mangaId)
        const newN = sf.mangaId ? newChapters[row.rootId]?.[sf.mangaId] : undefined
        return (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, opacity: manga?.isHidden ? 0.5 : 1 }}>
            <span className="ms" style={{ fontSize: 16, color: sf.synced ? 'var(--green)' : 'var(--text-muted)' }}>{sf.synced ? 'check_circle' : 'folder'}</span>
            <span style={{ fontSize: 13, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              {sf.synced ? sf.mangaTitle : sf.name}
              {manga?.linkedMangaId && <span className="ms" style={{ fontSize: 14, color: 'var(--accent)' }} title="Linked">link</span>}
              {newN ? <span style={{ fontSize: 10, fontWeight: 700, background: 'var(--green)', color: '#fff', borderRadius: 10, padding: '1px 6px' }}>+{newN} mới</span> : null}
            </span>
          </div>
        )
      },
    },
    {
      title: 'Trạng thái', key: 'status', width: 160,
      render: (_, row) => {
        if (row.kind === 'root') {
          const running = progress[row.rootId]?.status === 'Running'
          return running
            ? <span style={{ fontSize: 12, color: 'var(--accent)' }}>Đang sync {progress[row.rootId].percent}%</span>
            : <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>—</span>
        }
        if (row.kind === 'orphan') return <span style={{ fontSize: 12, color: 'var(--red)' }}>Đã xóa trên Drive</span>
        if (row.kind === 'folder') {
          return row.folder!.synced
            ? <span style={{ fontSize: 12, color: 'var(--green)' }}>Đã đồng bộ</span>
            : <span style={{ fontSize: 12, color: 'var(--accent)' }}>Chưa đồng bộ</span>
        }
        return null
      },
    },
    {
      title: 'Thao tác', key: 'actions', width: 130, align: 'right',
      render: (_, row) => {
        if (row.kind === 'loading') return null
        if (row.kind === 'root') {
          const f = row.root!
          const running = progress[f.id]?.status === 'Running'
          return (
            <div style={{ display: 'flex', gap: 4, justifyContent: 'flex-end' }}>
              <button className="icon-btn icon-btn-sm" onClick={() => syncRoot(f.id)} disabled={running} title="Đồng bộ toàn bộ" style={{ color: running ? 'var(--text-muted)' : 'var(--green)' }}>
                <span className={`ms ${running ? 'spin' : ''}`}>{running ? 'progress_activity' : 'sync'}</span>
              </button>
              {!f.isAutoAdded && (
                <Popconfirm title={`Xóa source "${f.name}"?`} onConfirm={() => del(f.id)} okText="Xóa" cancelText="Hủy" okButtonProps={{ danger: true }}>
                  <button className="icon-btn icon-btn-sm" title="Xóa" style={{ color: 'var(--red)' }}><span className="ms">delete</span></button>
                </Popconfirm>
              )}
            </div>
          )
        }
        if (row.kind === 'orphan') {
          const o = row.orphan!
          return (
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <Popconfirm title={`Xóa "${o.title}"?`} description="Xóa khỏi DB" onConfirm={() => deleteManga(o.id, row.rootId, o.title)} okText="Xóa" cancelText="Hủy" okButtonProps={{ danger: true }}>
                <button className="icon-btn icon-btn-sm" title="Xóa khỏi DB" style={{ color: 'var(--red)' }}><span className="ms">delete</span></button>
              </Popconfirm>
            </div>
          )
        }
        // folder
        const sf = row.folder!
        const manga = mangasByRoot[row.rootId]?.find(m => m.id === sf.mangaId)
        const running = progress[row.rootId]?.status === 'Running'
        if (sf.synced && sf.mangaId) {
          const isSyncing = syncingMangas.has(sf.mangaId)
          const disabled = running || isSyncing
          return (
            <div style={{ display: 'flex', gap: 4, justifyContent: 'flex-end' }}>
              <button className="icon-btn icon-btn-sm" onClick={() => syncManga(sf.mangaId!, sf.mangaTitle || sf.name)} disabled={disabled} title="Đồng bộ" style={{ color: disabled ? 'var(--text-muted)' : 'var(--green)' }}>
                <span className={`ms ${isSyncing ? 'spin' : ''}`}>{isSyncing ? 'progress_activity' : 'sync'}</span>
              </button>
              <button className="icon-btn icon-btn-sm" onClick={() => toggleVisibility(sf.mangaId!, row.rootId)} disabled={disabled || !!manga?.linkedMangaId} title={manga?.isHidden ? 'Hiện' : 'Ẩn'} style={{ color: (disabled || manga?.linkedMangaId) ? 'var(--text-muted)' : 'var(--accent)' }}>
                <span className="ms">{manga?.isHidden ? 'visibility_off' : 'visibility'}</span>
              </button>
              <Popconfirm title={`Xóa "${sf.mangaTitle || sf.name}"?`} description="Sẽ xóa toàn bộ data" onConfirm={() => deleteManga(sf.mangaId!, row.rootId, sf.mangaTitle || sf.name)} okText="Xóa" cancelText="Hủy" okButtonProps={{ danger: true }}>
                <button className="icon-btn icon-btn-sm" disabled={disabled} title="Xóa" style={{ color: disabled ? 'var(--text-muted)' : 'var(--red)' }}><span className="ms">delete</span></button>
              </Popconfirm>
            </div>
          )
        }
        return (
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <button className="icon-btn icon-btn-sm" onClick={() => syncSingleFromScan(row.rootId, sf.driveFileId, sf.name)} disabled={running} title="Đồng bộ folder này" style={{ color: running ? 'var(--text-muted)' : 'var(--green)' }}>
              <span className="ms">sync</span>
            </button>
          </div>
        )
      },
    },
  ]

  return (
    <>
      {selectedRowKeys.length > 0 && (
        <div style={{ marginBottom: 12, display: 'flex', alignItems: 'center', gap: 12 }}>
          <Button type="primary" loading={dispatching} onClick={syncSelected} style={{ borderRadius: 20 }}>
            <span className="ms ms-sm">sync</span> Đồng bộ ({selectedRowKeys.length})
          </Button>
          <button onClick={() => setSelectedRowKeys([])} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', fontSize: 13, cursor: 'pointer' }}>Bỏ chọn</button>
        </div>
      )}
      <Table<Row>
        rowKey="key"
        columns={columns}
        dataSource={data}
        pagination={false}
        rowSelection={{
          checkStrictly: true,
          selectedRowKeys,
          onChange: keys => setSelectedRowKeys(keys),
          // Loading/empty placeholder rows aren't selectable.
          getCheckboxProps: row => ({ disabled: row.kind === 'loading' }),
        }}
        expandable={{
          onExpand: (expanded, row) => { if (expanded && row.kind === 'root' && !scanResults[row.rootId]) onExpandRoot(row.rootId) },
        }}
      />
    </>
  )
}
