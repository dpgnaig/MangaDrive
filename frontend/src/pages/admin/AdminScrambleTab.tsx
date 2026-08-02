import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { Button, Progress, Select, Segmented, message } from 'antd'
import { generatePermutation, generateInversePermutation } from '../../lib/scramble'
import api from '../../lib/api'
import { connectDrive, disconnectDrive, pickDriveFolder, getConnectedEmail } from '../../lib/googleDrive'
import {
  type ChapterManifestEntry, readImageFiles, readSubDirs, readManifest, scanChapters,
  drawTiles, processToBlob, deriveChapterKey, newSlug,
} from '../../lib/scrambleFiles'
import {
  subscribeDriveRun, getDriveRunSnapshot, startDriveRun,
  cancelDriveRun, retryDriveChapter, cancelDriveChapterRow, resumeDriveFromPause,
  hasActiveOrPendingDriveRun, getLastDriveRunConfig,
} from '../../lib/scrambleDriveRun'
import { ChapterRunRow, CHAPTER_ROW_HEIGHT } from '../../components/ChapterRunRow'
import { useVirtualizedRows } from '../../hooks/useVirtualizedRows'

type Dest = 'local' | 'drive'

type Mode = 'scramble' | 'unscramble'

// Bounds for the admin-selectable "chapters upload concurrently" setting —
// admins can trade off upload speed against how hard the run leans on
// Drive's rate limits.
const CHAPTER_CONCURRENCY_OPTIONS = [2, 3, 4, 5]
const DEFAULT_CHAPTER_CONCURRENCY = 2

// Chapter row list virtualization: only mount rows near the visible scroll
// window instead of every chapter, so admin runs with hundreds/thousands of
// chapters don't force React to reconcile the whole list on every progress
// tick (each uploaded image patches one row's doneCount). ROW_SLOT bakes in
// the visual gap between rows so absolute-positioned rows still look spaced.
const CHAPTER_ROW_SLOT = CHAPTER_ROW_HEIGHT + 6
const CHAPTER_LIST_MAX_HEIGHT = 360
const CHAPTER_LIST_OVERSCAN = 4

function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return `${m}m ${s % 60}s`
}

export default function AdminScrambleTab() {
  const [mode, setMode] = useState<Mode>('scramble')
  const [grid, setGrid] = useState(6)
  const [inputDir, setInputDir] = useState<FileSystemDirectoryHandle | null>(null)
  const [outputDir, setOutputDir] = useState<FileSystemDirectoryHandle | null>(null)
  // Where scrambled output goes: a local folder (original flow) or straight up to
  // the admin's personal Drive. Unscramble is always local.
  const [dest, setDest] = useState<Dest>('local')
  // Drive scramble target: a brand-new manga (create run root + manga folder) or
  // append new chapters into an EXISTING manga folder picked via Google Picker.
  const [driveMode, setDriveMode] = useState<'new' | 'append'>('new')
  const [driveTarget, setDriveTarget] = useState<{ id: string; name: string } | null>(null)
  const [picking, setPicking] = useState(false)
  const [driveEmail, setDriveEmail] = useState<string | null>(null)
  const [driveConnecting, setDriveConnecting] = useState(false)
  const [serviceEmail, setServiceEmail] = useState('')
  // How many chapters upload concurrently during a Drive scramble run — admin-selectable
  // between CHAPTER_CONCURRENCY_OPTIONS so they can trade upload speed against how hard
  // the run leans on Drive's rate limits.
  const [chapterConcurrency, setChapterConcurrency] = useState(DEFAULT_CHAPTER_CONCURRENCY)
  // Local (non-Drive) run state — the Drive path's run state lives in the
  // scrambleDriveRun module store instead (see driveSnap below), so it
  // survives this component unmounting when the admin navigates away.
  const [running, setRunning] = useState(false)
  const [done, setDone] = useState(0)
  const [total, setTotal] = useState(0)
  const [currentLabel, setCurrentLabel] = useState('')
  // Icon paired with currentLabel so each run phase (scan/check/process/restore)
  // reads as a distinct step instead of a plain string that happens to change.
  const [currentIcon, setCurrentIcon] = useState('sync')
  const [elapsed, setElapsed] = useState(0)
  const cancelledRef = useRef(false)
  const startedRef = useRef(0)

  // Live snapshot of the Drive upload run, owned by scrambleDriveRun.ts at
  // module scope so it keeps progressing (and this component picks up the
  // true state) even if the admin navigated away and back mid-run.
  const driveSnap = useSyncExternalStore(subscribeDriveRun, getDriveRunSnapshot)
  const toDrive = mode === 'scramble' && dest === 'drive'
  const isRunning = toDrive ? driveSnap.running : running
  const displayDone = toDrive ? driveSnap.done : done
  const displayTotal = toDrive ? driveSnap.total : total
  const displayLabel = toDrive ? driveSnap.currentLabel : currentLabel

  // Preview: two canvases (original + processed) drawn from the first image.
  const origCanvasRef = useRef<HTMLCanvasElement>(null)
  const procCanvasRef = useRef<HTMLCanvasElement>(null)
  const [previewReady, setPreviewReady] = useState(false)
  const [previewing, setPreviewing] = useState(false)

  useEffect(() => {
    // Service account email is needed so uploaded folders can be shared back to
    // the read-only account that /api/images proxies through.
    api.get('/admin/drive/service-account')
      .then(r => setServiceEmail(r.data?.email ?? ''))
      .catch(() => {})
  }, [])

  // This component remounts with default state every time the admin navigates
  // away and back (switching admin tabs, or leaving /admin entirely) — but a
  // Drive run keeps going in the scrambleDriveRun module store regardless. If
  // one is active (or finished with error rows still needing attention),
  // restore the selects that describe it instead of leaving them reset to
  // defaults ("Local"/"Manga mới"/grid 6) while driveSnap shows a live/lingering
  // run for a completely different configuration. driveEmail is similarly
  // re-synced from the token module (googleDrive.ts) rather than starting
  // "disconnected" even though the run is actively using that connection.
  useEffect(() => {
    if (hasActiveOrPendingDriveRun()) {
      setMode('scramble')
      setDest('drive')
      const cfg = getLastDriveRunConfig()
      setGrid(cfg.grid)
      setDriveMode(cfg.driveMode)
      setDriveTarget(cfg.driveTarget)
    }
    const email = getConnectedEmail()
    if (email) setDriveEmail(email)
  }, [])

  // Tick a 1s timer while a run is in flight so elapsed time / ETA / speed stay
  // live in the progress panel. Base timestamp comes from the module store's
  // startedAt for the Drive path (the true start time, even after navigating
  // back mid-run) or the local startedRef otherwise.
  useEffect(() => {
    if (!isRunning) return
    const base = toDrive ? driveSnap.startedAt : startedRef.current
    const id = setInterval(() => setElapsed(Date.now() - base), 1000)
    return () => clearInterval(id)
  }, [isRunning, toDrive, driveSnap.startedAt])

  // Chapter row list virtualization: only mount rows near the visible scroll
  // window (see useVirtualizedRows) instead of every chapter — a run with
  // hundreds/thousands of chapters would otherwise force React to reconcile
  // the whole list on every progress tick (one per uploaded image).
  const chapterList = useVirtualizedRows(CHAPTER_ROW_SLOT, CHAPTER_LIST_MAX_HEIGHT, CHAPTER_LIST_OVERSCAN, driveSnap.chapterRuns.length)

  // Connect (or switch) the personal Drive that scrambled output uploads into.
  // forceSelect shows Google's account chooser for a manual account switch.
  const connectDriveAccount = async (forceSelect: boolean) => {
    setDriveConnecting(true)
    try {
      const email = await connectDrive(forceSelect)
      setDriveEmail(email)
      message.success(email ? `Đã kết nối Drive: ${email}` : 'Đã kết nối Drive')
    } catch (e: any) {
      message.error(e?.message || 'Kết nối Drive thất bại')
    }
    setDriveConnecting(false)
  }

  const disconnectDriveAccount = () => {
    disconnectDrive()
    setDriveEmail(null)
    setDriveTarget(null)
  }

  // Pick an existing manga folder (from a prior scramble run) to append new
  // chapters into. Requires a connected Drive first — the Picker reuses that token.
  const pickTargetFolder = async () => {
    if (!driveEmail) { message.warning('Vui lòng kết nối Google Drive trước'); return }
    setPicking(true)
    try {
      const picked = await pickDriveFolder()
      if (picked) {
        setDriveTarget(picked)
        message.success(`Đã chọn manga đích: ${picked.name}`)
      }
    } catch (e: any) {
      message.error(e?.message || 'Chọn folder thất bại')
    }
    setPicking(false)
  }

  const pickInput = async () => {
    try {
      const handle = await window.showDirectoryPicker({ id: 'scramble-input' })
      setInputDir(handle)
      setPreviewReady(false)
    } catch { /* user cancelled */ }
  }

  const pickOutput = async () => {
    try {
      const handle = await window.showDirectoryPicker({ id: 'scramble-output', mode: 'readwrite' })
      setOutputDir(handle)
    } catch { /* user cancelled */ }
  }

  // Draw the first image (original + processed) into the preview canvases.
  // Scramble mode derives an illustrative HMAC key from a fixed preview slug,
  // following the same Phase 2 pipeline as a real randomly generated slug.
  // Unscramble mode reads the real slug+grid from manifest.json and reverses
  // the first image of the first chapter — a genuine check that the key unlocks it.
  const doPreview = async () => {
    if (!inputDir) { message.warning('Vui lòng chọn folder input'); return }
    setPreviewing(true)
    try {
      let fileHandle: FileSystemFileHandle | null = null
      let perm: number[]
      let g = grid

      if (mode === 'scramble') {
        const subDirs = await readSubDirs(inputDir)
        const firstDir = subDirs.length > 0 ? subDirs[0].handle : inputDir
        const files = await readImageFiles(firstDir)
        if (files.length === 0) { message.warning('Không tìm thấy ảnh trong folder'); return }
        fileHandle = files[0].handle
        perm = generatePermutation(await deriveChapterKey('000000000000'), g)
      } else {
        const manifest = await readManifest(inputDir)
        if (manifest.length === 0) { message.warning('manifest.json không có chapter'); return }
        const entry = manifest[0]
        g = entry.grid
        const chapterDir = await inputDir.getDirectoryHandle(entry.slug)
        const files = await readImageFiles(chapterDir)
        if (files.length === 0) { message.warning('Chapter đầu tiên không có ảnh'); return }
        fileHandle = files[0].handle
        perm = generateInversePermutation(await deriveChapterKey(entry.slug), g)
      }

      const blob = await fileHandle.getFile()
      const bitmap = await createImageBitmap(blob)
      try {
        const orig = origCanvasRef.current
        const proc = procCanvasRef.current
        if (!orig || !proc) return
        orig.width = proc.width = bitmap.width
        orig.height = proc.height = bitmap.height
        const octx = orig.getContext('2d')
        const pctx = proc.getContext('2d')
        if (!octx || !pctx) return
        octx.drawImage(bitmap, 0, 0)
        drawTiles(pctx, bitmap, perm, g)
        setPreviewReady(true)
      } finally {
        bitmap.close()
      }
    } catch (e) {
      message.error(`Lỗi preview: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setPreviewing(false)
    }
  }

  // Local scramble: unchanged from the original flow — process every chapter,
  // write manifest.json once at the end. No skip/resume logic; local runs are
  // fast enough that resuming a partial run isn't worth the complexity here.
  const runScrambleLocal = async (
    chapterFiles: { name: string; handle: FileSystemDirectoryHandle; files: { name: string; handle: FileSystemFileHandle }[] }[],
  ) => {
    const grandTotal = chapterFiles.reduce((sum, ch) => sum + ch.files.length, 0)
    setTotal(grandTotal)

    const manifest: ChapterManifestEntry[] = []
    const usedSlugs = new Set<string>()
    let processed = 0
    startedRef.current = Date.now()

    for (const ch of chapterFiles) {
      if (cancelledRef.current) break
      const slug = newSlug(usedSlugs)
      const key = await deriveChapterKey(slug)
      setCurrentLabel(`${ch.name} → ${slug}`)

      const outChapterDir = await outputDir!.getDirectoryHandle(slug, { create: true })
      const numbered = ch.files.map((file, i) => ({ file, seq: i + 1 }))

      for (const { file, seq } of numbered) {
        if (cancelledRef.current) break
        const blob = await file.handle.getFile()
        const bitmap = await createImageBitmap(blob)
        try {
          const perm = generatePermutation(key, grid)
          const outBlob = await processToBlob(bitmap, perm, grid)
          const fileName = `${String(seq).padStart(3, '0')}.png`
          const fileHandle = await outChapterDir.getFileHandle(fileName, { create: true })
          const writable = await fileHandle.createWritable()
          await writable.write(outBlob)
          await writable.close()
        } finally {
          bitmap.close()
        }
        processed++
        setDone(processed)
      }
      manifest.push({ original: ch.name, slug, grid, fileCount: ch.files.length, order: manifest.length })
    }

    if (cancelledRef.current) { message.info('Đã hủy'); return }

    const manifestHandle = await outputDir!.getFileHandle('manifest.json', { create: true })
    const manifestWritable = await manifestHandle.createWritable()
    await manifestWritable.write(JSON.stringify(manifest, null, 2))
    await manifestWritable.close()

    message.success(`Hoàn thành! ${manifest.length} chapter, ${processed} ảnh đã xáo.`)
  }

  const runUnscramble = async () => {
    // Reads <input>/manifest.json; for each entry, requests its server-derived key
    // and restores <input>/<slug>/* back to <output>/<original>/NNN.png.
    const manifest = await readManifest(inputDir!)
    if (manifest.length === 0) {
      message.error('manifest.json không có chapter. Unscramble cần folder output do tool tạo ra.')
      return
    }

    const chapters: { entry: ChapterManifestEntry; files: { name: string; handle: FileSystemFileHandle }[] }[] = []
    let grandTotal = 0
    for (const entry of manifest) {
      const chapterDir = await inputDir!.getDirectoryHandle(entry.slug).catch(() => null)
      if (!chapterDir) continue
      const files = await readImageFiles(chapterDir)
      if (files.length === 0) continue
      chapters.push({ entry, files })
      grandTotal += files.length
    }
    setTotal(grandTotal)
    if (grandTotal === 0) { message.warning('Không tìm thấy ảnh theo manifest'); return }

    let processed = 0
    for (const { entry, files } of chapters) {
      if (cancelledRef.current) break
      const key = await deriveChapterKey(entry.slug)
      const outChapterDir = await outputDir!.getDirectoryHandle(entry.original, { create: true })

      let seq = 1
      for (const file of files) {
        if (cancelledRef.current) break
        setCurrentLabel(`${entry.slug} → ${entry.original}`)
        const blob = await file.handle.getFile()
        const bitmap = await createImageBitmap(blob)
        try {
          const perm = generateInversePermutation(key, entry.grid)
          const outBlob = await processToBlob(bitmap, perm, entry.grid)
          const fileHandle = await outChapterDir.getFileHandle(`${String(seq).padStart(3, '0')}.png`, { create: true })
          const writable = await fileHandle.createWritable()
          await writable.write(outBlob)
          await writable.close()
        } finally {
          bitmap.close()
        }
        seq++
        processed++
        setDone(processed)
      }
    }

    if (cancelledRef.current) { message.info('Đã hủy'); return }
    message.success(`Hoàn thành! ${chapters.length} chapter, ${processed} ảnh đã khôi phục.`)
  }

  const start = async () => {
    if (!inputDir) { message.warning('Vui lòng chọn folder input'); return }
    // Unscramble always writes local. Scramble writes local OR to Drive.
    if (!toDrive && !outputDir) { message.warning('Vui lòng chọn folder output'); return }
    if (toDrive && !driveEmail) { message.warning('Vui lòng kết nối Google Drive trước'); return }
    if (toDrive && !serviceEmail) { message.warning('Chưa lấy được service account email, thử lại sau'); return }
    if (toDrive && driveMode === 'append' && !driveTarget) { message.warning('Vui lòng chọn manga đích để thêm chapter'); return }

    if (toDrive) {
      // Drive runs live in the scrambleDriveRun module store, detached from
      // this component, so they keep going if the admin navigates away.
      const chapterFiles = await scanChapters(inputDir)
      if (chapterFiles.length === 0) { message.warning('Không tìm thấy ảnh trong folder'); return }
      startDriveRun({
        chapterFiles,
        inputDir,
        driveMode,
        driveTarget,
        grid,
        serviceEmail,
        chapterConcurrency,
      })
      // The store now owns the file handles it needs — free up the picker
      // right away instead of waiting for the run to finish.
      setInputDir(null)
      setPreviewReady(false)
      return
    }

    cancelledRef.current = false
    setRunning(true)
    setDone(0)
    setTotal(0)
    setCurrentIcon('folder_open')
    setCurrentLabel('Đang quét folder...')

    try {
      if (mode === 'scramble') {
        const chapterFiles = await scanChapters(inputDir)
        if (chapterFiles.length === 0) { message.warning('Không tìm thấy ảnh trong folder'); return }
        await runScrambleLocal(chapterFiles)
      } else {
        await runUnscramble()
      }
    } catch (e) {
      message.error(`Lỗi: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setRunning(false)
      setCurrentLabel('')
    }
  }

  const cancel = () => {
    if (toDrive) {
      cancelDriveRun()
    } else {
      cancelledRef.current = true
    }
  }

  const supported = typeof window !== 'undefined' && 'showDirectoryPicker' in window

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 12 }}>
        <h2 style={{ fontSize: 16, fontWeight: 600, margin: 0 }}>Scramble ảnh</h2>
        <a href="/downloads/manga-download.zip" download style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13, color: 'var(--accent)' }}>
          <span className="ms ms-sm">download</span> Tải tool scramble (.zip)
        </a>
      </div>

      {!supported && (
        <div style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 12, padding: 16, marginBottom: 16, color: 'var(--text-muted)', fontSize: 13 }}>
          Trình duyệt không hỗ trợ File System Access API. Vui lòng dùng Chrome hoặc Edge trên desktop.
        </div>
      )}

      <div style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 12, padding: 16 }}>
        <Segmented
          value={mode}
          onChange={v => { setMode(v as Mode); setPreviewReady(false) }}
          disabled={isRunning}
          options={[
            { label: 'Scramble (xáo)', value: 'scramble' },
            { label: 'Unscramble (khôi phục)', value: 'unscramble' },
          ]}
          style={{ marginBottom: 12 }}
        />

        <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 16 }}>
          {mode === 'scramble'
            ? 'Xáo ảnh local trước khi upload. Mỗi thư mục con = 1 chapter, dùng khóa riêng do server dẫn xuất theo slug. Kết quả ghi PNG kèm manifest.json.'
            : 'Khôi phục ảnh đã xáo bằng khóa riêng do server dẫn xuất. Folder input phải chứa manifest.json; kết quả ghi ra <output>/<tên chapter gốc>/NNN.png.'}
        </p>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {mode === 'scramble' && (
            <div>
              <label style={{ fontSize: 13, fontWeight: 500, display: 'block', marginBottom: 6 }}>Grid</label>
              <Select
                value={grid}
                onChange={v => { setGrid(v); setPreviewReady(false) }}
                disabled={isRunning}
                style={{ width: 120 }}
                options={[3, 4, 5, 6, 8].map(g => ({ value: g, label: `${g}x${g}` }))}
              />
            </div>
          )}

          {/* Scramble destination: local folder (original flow) or push straight
              to the admin's personal Google Drive. Unscramble is always local. */}
          {mode === 'scramble' && (
            <div>
              <label style={{ fontSize: 13, fontWeight: 500, display: 'block', marginBottom: 6 }}>Đích ghi kết quả</label>
              <Segmented
                value={dest}
                onChange={v => setDest(v as Dest)}
                disabled={isRunning}
                options={[
                  { label: 'Folder local', value: 'local' },
                  { label: 'Google Drive', value: 'drive' },
                ]}
              />
            </div>
          )}

          {/* Drive account: connect / switch / disconnect. Shows which personal
              Drive uploads land in; account switch re-opens Google's chooser. */}
          {mode === 'scramble' && dest === 'drive' && (
            <div style={{ background: 'var(--bg-base)', border: '1px solid var(--border)', borderRadius: 10, padding: 12 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                <span className="ms ms-sm" style={{ color: driveEmail ? 'var(--green, #4caf50)' : 'var(--text-muted)' }}>
                  {driveEmail ? 'cloud_done' : 'cloud_off'}
                </span>
                <span style={{ fontSize: 13, color: driveEmail ? 'var(--text)' : 'var(--text-muted)' }}>
                  {driveEmail ? `Drive: ${driveEmail}` : 'Chưa kết nối Google Drive'}
                </span>
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <Button onClick={() => connectDriveAccount(false)} loading={driveConnecting} disabled={isRunning} style={{ borderRadius: 20, height: 34 }}>
                  <span className="ms ms-sm">login</span> {driveEmail ? 'Kết nối lại' : 'Kết nối Drive'}
                </Button>
                <Button onClick={() => connectDriveAccount(true)} disabled={isRunning || driveConnecting} style={{ borderRadius: 20, height: 34 }}>
                  <span className="ms ms-sm">switch_account</span> Đổi tài khoản
                </Button>
                {driveEmail && (
                  <Button onClick={disconnectDriveAccount} disabled={isRunning} danger style={{ borderRadius: 20, height: 34 }}>
                    <span className="ms ms-sm">logout</span> Ngắt kết nối
                  </Button>
                )}
              </div>
              {serviceEmail && (
                <p style={{ fontSize: 11, color: 'var(--text-muted)', margin: '8px 0 0' }}>
                  Folder upload sẽ tự chia sẻ (chỉ đọc) tới service account <b>{serviceEmail}</b> để web đọc được ảnh.
                </p>
              )}
            </div>
          )}

          {/* Drive target: create a new manga folder, or append new chapters into an
              existing manga folder (picked via Google Picker). Append downloads the
              existing manifest and merges the new chapter entries so old chapters keep
              their slug/grid. */}
          {mode === 'scramble' && dest === 'drive' && (
            <div>
              <label style={{ fontSize: 13, fontWeight: 500, display: 'block', marginBottom: 6 }}>Đích trên Drive</label>
              <Segmented
                value={driveMode}
                onChange={v => { setDriveMode(v as 'new' | 'append'); setDriveTarget(null) }}
                disabled={isRunning}
                options={[
                  { label: 'Manga mới', value: 'new' },
                  { label: 'Thêm chapter vào manga có sẵn', value: 'append' },
                ]}
                style={{ marginBottom: driveMode === 'append' ? 8 : 0 }}
              />
              {driveMode === 'append' && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <Button onClick={pickTargetFolder} loading={picking} disabled={isRunning || !driveEmail} style={{ borderRadius: 20, height: 34 }}>
                    <span className="ms ms-sm">folder_special</span> {driveTarget ? `Manga: ${driveTarget.name}` : 'Chọn manga đích'}
                  </Button>
                  <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                    Chỉ chọn folder manga đã scramble trước đó (chứa manifest.json).
                  </span>
                </div>
              )}
            </div>
          )}

          {/* Chapters upload concurrently during a Drive run — higher values upload
              faster but lean harder on Drive's rate limits. */}
          {mode === 'scramble' && dest === 'drive' && (
            <div>
              <label style={{ fontSize: 13, fontWeight: 500, display: 'block', marginBottom: 6 }}>Số chapter upload đồng thời</label>
              <Select
                value={chapterConcurrency}
                onChange={setChapterConcurrency}
                disabled={isRunning}
                style={{ width: 120 }}
                options={CHAPTER_CONCURRENCY_OPTIONS.map(n => ({ value: n, label: String(n) }))}
              />
            </div>
          )}

          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <Button onClick={pickInput} disabled={isRunning || !supported} style={{ borderRadius: 20, height: 36 }}>
              <span className="ms ms-sm">folder_open</span> {inputDir ? `Input: ${inputDir.name}` : 'Chọn folder input'}
            </Button>
            {!(mode === 'scramble' && dest === 'drive') && (
              <Button onClick={pickOutput} disabled={isRunning || !supported} style={{ borderRadius: 20, height: 36 }}>
                <span className="ms ms-sm">drive_folder_upload</span> {outputDir ? `Output: ${outputDir.name}` : 'Chọn folder output'}
              </Button>
            )}
            <Button onClick={doPreview} loading={previewing} disabled={isRunning || !supported} style={{ borderRadius: 20, height: 36 }}>
              <span className="ms ms-sm">visibility</span> Preview
            </Button>
          </div>

          {/* Before / after preview of the first image. */}
          <div style={{ display: previewReady ? 'grid' : 'none', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div>
              <p style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>{mode === 'scramble' ? 'Gốc' : 'Đã xáo (input)'}</p>
              <canvas ref={origCanvasRef} style={{ width: '100%', height: 'auto', borderRadius: 8, background: '#111' }} />
            </div>
            <div>
              <p style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>{mode === 'scramble' ? 'Đã xáo (minh hoạ)' : 'Khôi phục'}</p>
              <canvas ref={procCanvasRef} style={{ width: '100%', height: 'auto', borderRadius: 8, background: '#111' }} />
            </div>
          </div>
          {mode === 'scramble' && previewReady && (
            <p style={{ fontSize: 11, color: 'var(--text-muted)', margin: 0 }}>
              Preview dùng slug cố định "000000000000" và khóa do server dẫn xuất; slug thật sinh ngẫu nhiên khi chạy nên ảnh xáo thực tế sẽ khác.
            </p>
          )}

          {/* Drive path: per-chapter progress list (chapters upload concurrently, so a
              single flat progress bar can't show which chapter is stuck/failed). Local
              scramble and unscramble keep the original single aggregate bar below.
              Reads from driveSnap (the module store) so this reflects the true run
              state even right after navigating back to this tab mid-run. */}
          {isRunning && mode === 'scramble' && dest === 'drive' && (() => {
            const speed = elapsed > 0 ? displayDone / (elapsed / 1000) : 0
            const remaining = speed > 0 && displayDone < displayTotal ? Math.round(((displayTotal - displayDone) / speed) * 1000) : 0
            return (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ background: 'var(--bg-base)', border: '1px solid var(--border)', borderRadius: 10, padding: 12 }}>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 16px', fontSize: 12, color: 'var(--text-muted)' }}>
                    <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                      <span className="ms ms-xs" style={{ fontSize: 14 }}>image</span>
                      <b style={{ color: 'var(--text)' }}>{displayDone}/{displayTotal}</b> ảnh
                    </span>
                    <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                      <span className="ms ms-xs" style={{ fontSize: 14 }}>schedule</span>
                      {formatDuration(elapsed)}
                    </span>
                    {speed > 0 && (
                      <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                        <span className="ms ms-xs" style={{ fontSize: 14 }}>speed</span>
                        {speed.toFixed(1)} ảnh/s
                      </span>
                    )}
                    {speed > 0 && displayDone < displayTotal && (
                      <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                        <span className="ms ms-xs" style={{ fontSize: 14 }}>hourglass_empty</span>
                        Còn lại ~{formatDuration(remaining)}
                      </span>
                    )}
                  </div>
                  {/* Preflight ("chapter đã có trên Drive chưa") result — once the
                      check finishes, checkedSummary replaces the transient
                      "checking (n/n)" text with a fixed green-check line instead of
                      leaving stale progress text on screen through the whole upload. */}
                  {toDrive && driveSnap.checkedSummary && (
                    <p style={{ fontSize: 12, color: 'var(--text)', margin: '6px 0 0', display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span className="ms ms-xs" style={{ fontSize: 14, color: 'var(--green, #4caf50)' }}>check_circle</span>
                      {driveSnap.checkedSummary}
                    </p>
                  )}
                  {displayLabel && (
                    <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '4px 0 0', display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span className={currentIcon === 'sync' ? 'ms ms-xs spin' : 'ms ms-xs'} style={{ fontSize: 14 }}>{currentIcon}</span>
                      {displayLabel}
                    </p>
                  )}
                </div>

                {driveSnap.pausedInfo && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, background: 'var(--bg-elevated)', border: '1px solid var(--red, #e5484d)', borderRadius: 10, padding: '10px 14px' }}>
                    <span className="ms" style={{ fontSize: 18, color: 'var(--red, #e5484d)' }}>error</span>
                    <p style={{ fontSize: 12, color: 'var(--text)', margin: 0, flex: 1 }}>{driveSnap.pausedInfo}</p>
                    <Button size="small" onClick={resumeDriveFromPause} style={{ borderRadius: 16 }}>Tiếp tục</Button>
                  </div>
                )}

                {driveSnap.chapterRuns.length > 0 && (() => {
                  // Only mount rows within [startIndex, endIndex) of the current scroll
                  // position (plus overscan on both sides) — chapterRuns can run into the
                  // hundreds/thousands, and reconciling every row's DOM node on each
                  // progress tick (one per uploaded image) is the FE cost this avoids.
                  const rowCount = driveSnap.chapterRuns.length
                  const visible = driveSnap.chapterRuns.slice(chapterList.startIndex, chapterList.endIndex)
                  return (
                    <div onScroll={chapterList.onScroll} style={{ maxHeight: CHAPTER_LIST_MAX_HEIGHT, overflowY: 'auto' }}>
                      <div style={{ position: 'relative', height: rowCount * CHAPTER_ROW_SLOT }}>
                        {visible.map((c, i) => (
                          <div key={c.name} style={{ position: 'absolute', top: (chapterList.startIndex + i) * CHAPTER_ROW_SLOT, left: 0, right: 0 }}>
                            <ChapterRunRow chapter={c} onRetry={retryDriveChapter} onCancel={cancelDriveChapterRow} />
                          </div>
                        ))}
                      </div>
                    </div>
                  )
                })()}
              </div>
            )
          })()}

          {/* Local scramble / unscramble: single aggregate progress bar (unchanged). */}
          {isRunning && !(mode === 'scramble' && dest === 'drive') && (() => {
            const pct = total > 0 ? Math.round((done / total) * 100) : 0
            // Speed + ETA derive from elapsed wall time; guard the first tick
            // (elapsed 0) so we don't divide by zero or show Infinity.
            const speed = elapsed > 0 ? done / (elapsed / 1000) : 0
            const remaining = speed > 0 ? Math.round(((total - done) / speed) * 1000) : 0
            return (
              <div style={{ background: 'var(--bg-base)', border: '1px solid var(--border)', borderRadius: 10, padding: 12 }}>
                <Progress percent={pct} status="active" />
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 16px', fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>
                  <span><b style={{ color: 'var(--text)' }}>{done}/{total}</b> ảnh</span>
                  <span>Thời gian: {formatDuration(elapsed)}</span>
                  {speed > 0 && <span>Tốc độ: {speed.toFixed(1)} ảnh/s</span>}
                  {speed > 0 && done < total && <span>Còn lại: ~{formatDuration(remaining)}</span>}
                </div>
                {currentLabel && (
                  <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '4px 0 0' }}>{currentLabel}</p>
                )}
              </div>
            )
          })()}

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 4 }}>
            {isRunning && <Button onClick={cancel} danger style={{ borderRadius: 20, height: 36 }}>Hủy</Button>}
            <Button type="primary" onClick={start} loading={isRunning} disabled={!supported} style={{ borderRadius: 20, height: 36 }}>
              {mode === 'scramble' ? 'Bắt đầu xáo' : 'Bắt đầu khôi phục'}
            </Button>
          </div>
        </div>
      </div>
    </>
  )
}
