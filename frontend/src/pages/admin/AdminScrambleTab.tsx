import { useEffect, useRef, useState } from 'react'
import { Input, Button, Progress, Select, Segmented, message } from 'antd'
import { generatePermutation, generateInversePermutation } from '../../lib/scramble'
import api from '../../lib/api'
import { connectDrive, disconnectDrive, createDriveFolder, uploadDriveFile, shareWithServiceAccount } from '../../lib/googleDrive'

type Dest = 'local' | 'drive'

interface ChapterManifestEntry {
  original: string
  slug: string
  grid: number
  fileCount: number
}

type Mode = 'scramble' | 'unscramble'

const IMAGE_EXT = /\.(jpe?g|png|webp|bmp)$/i

// How many Drive uploads to keep in flight at once. Uploads are network-bound,
// so overlapping them hides per-request latency; too many and Google starts
// returning 403 rateLimitExceeded, so keep this modest.
const DRIVE_CONCURRENCY = 4

// Run `worker` over `items` with at most `limit` in flight at once. Resolves
// when every item finishes. A worker that throws rejects the whole pool (the
// caller's try/catch surfaces it), matching the old serial-loop behaviour.
async function runPool<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  let next = 0
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++
      await worker(items[i])
    }
  })
  await Promise.all(runners)
}

function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return `${m}m ${s % 60}s`
}

function newSlug(): string {
  const bytes = new Uint8Array(6)
  crypto.getRandomValues(bytes)
  const hex = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')
  return `chapter-${hex}`
}

// Rearrange tiles of `bitmap` onto `ctx` using `perm`: output tile destIdx = source
// tile perm[destIdx]. Same math for scramble (forward perm) and unscramble (inverse
// perm) — only the permutation differs. Mirrors ImageProcessor.cs RearrangeTiles.
function drawTiles(ctx: CanvasRenderingContext2D, bitmap: ImageBitmap, perm: number[], grid: number) {
  const tileW = Math.floor(bitmap.width / grid)
  const tileH = Math.floor(bitmap.height / grid)
  for (let destIdx = 0; destIdx < perm.length; destIdx++) {
    const srcIdx = perm[destIdx]
    const srcCol = srcIdx % grid
    const srcRow = Math.floor(srcIdx / grid)
    const destCol = destIdx % grid
    const destRow = Math.floor(destIdx / grid)
    ctx.drawImage(
      bitmap,
      srcCol * tileW, srcRow * tileH, tileW, tileH,
      destCol * tileW, destRow * tileH, tileW, tileH
    )
  }
}

async function processToBlob(bitmap: ImageBitmap, perm: number[], grid: number): Promise<Blob> {
  const canvas = document.createElement('canvas')
  canvas.width = bitmap.width
  canvas.height = bitmap.height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Canvas 2D context unavailable')
  drawTiles(ctx, bitmap, perm, grid)
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      blob => (blob ? resolve(blob) : reject(new Error('toBlob returned null'))),
      'image/png'
    )
  })
}

// Collect image files directly inside a directory handle, sorted by name.
async function readImageFiles(dir: FileSystemDirectoryHandle): Promise<{ name: string; handle: FileSystemFileHandle }[]> {
  const files: { name: string; handle: FileSystemFileHandle }[] = []
  for await (const [name, handle] of dir.entries()) {
    if (handle.kind === 'file' && IMAGE_EXT.test(name)) {
      files.push({ name, handle: handle as FileSystemFileHandle })
    }
  }
  files.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
  return files
}

// Collect direct subdirectories, sorted by name. Each = one chapter.
async function readSubDirs(dir: FileSystemDirectoryHandle): Promise<{ name: string; handle: FileSystemDirectoryHandle }[]> {
  const dirs: { name: string; handle: FileSystemDirectoryHandle }[] = []
  for await (const [name, handle] of dir.entries()) {
    if (handle.kind === 'directory') {
      dirs.push({ name, handle: handle as FileSystemDirectoryHandle })
    }
  }
  dirs.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
  return dirs
}

// Read + parse manifest.json at the root of a directory handle.
async function readManifest(dir: FileSystemDirectoryHandle): Promise<ChapterManifestEntry[]> {
  const handle = await dir.getFileHandle('manifest.json')
  const text = await (await handle.getFile()).text()
  return JSON.parse(text)
}

export default function AdminScrambleTab() {
  const [mode, setMode] = useState<Mode>('scramble')
  const [masterKey, setMasterKey] = useState('')
  const [grid, setGrid] = useState(6)
  const [inputDir, setInputDir] = useState<FileSystemDirectoryHandle | null>(null)
  const [outputDir, setOutputDir] = useState<FileSystemDirectoryHandle | null>(null)
  // Where scrambled output goes: a local folder (original flow) or straight up to
  // the admin's personal Drive. Unscramble is always local.
  const [dest, setDest] = useState<Dest>('local')
  const [driveEmail, setDriveEmail] = useState<string | null>(null)
  const [driveConnecting, setDriveConnecting] = useState(false)
  const [serviceEmail, setServiceEmail] = useState('')
  const [running, setRunning] = useState(false)
  const [done, setDone] = useState(0)
  const [total, setTotal] = useState(0)
  const [currentLabel, setCurrentLabel] = useState('')
  const [elapsed, setElapsed] = useState(0)
  const cancelledRef = useRef(false)
  const startedRef = useRef(0)

  // Preview: two canvases (original + processed) drawn from the first image.
  const origCanvasRef = useRef<HTMLCanvasElement>(null)
  const procCanvasRef = useRef<HTMLCanvasElement>(null)
  const [previewReady, setPreviewReady] = useState(false)
  const [previewing, setPreviewing] = useState(false)

  // Master password: hash stored server-side, verify-only. Used to catch typos
  // in the master key (a mistyped key produces unrecoverable output).
  const [pwStatusLoading, setPwStatusLoading] = useState(true)
  const [isPwSet, setIsPwSet] = useState(false)
  const [pwCurrent, setPwCurrent] = useState('')
  const [pwNew, setPwNew] = useState('')
  const [pwSaving, setPwSaving] = useState(false)

  useEffect(() => {
    api.get('/settings/master-password/status')
      .then(r => setIsPwSet(!!r.data?.isSet))
      .catch(() => {})
      .finally(() => setPwStatusLoading(false))
    // Service account email is needed so uploaded folders can be shared back to
    // the read-only account that /api/images proxies through.
    api.get('/admin/drive/service-account')
      .then(r => setServiceEmail(r.data?.email ?? ''))
      .catch(() => {})
  }, [])

  // Tick a 1s timer while a run is in flight so elapsed time / ETA / speed stay
  // live in the progress panel. startedRef is set at the top of each run.
  useEffect(() => {
    if (!running) return
    const id = setInterval(() => setElapsed(Date.now() - startedRef.current), 1000)
    return () => clearInterval(id)
  }, [running])

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
  }

  const savePassword = async () => {
    if (!pwNew.trim()) { message.warning('Vui lòng nhập master password mới'); return }
    setPwSaving(true)
    try {
      await api.post('/settings/master-password', {
        currentPassword: isPwSet ? pwCurrent : undefined,
        newPassword: pwNew,
      })
      message.success(isPwSet ? 'Đã đổi master password' : 'Đã đặt master password')
      setIsPwSet(true)
      setPwCurrent('')
      setPwNew('')
    } catch (e: any) {
      message.error(e?.response?.data?.message || 'Lưu master password thất bại')
    }
    setPwSaving(false)
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

  // Verify the typed key against the stored hash. A mistyped key would produce
  // output that can never be reversed, so we block before touching any files.
  const verifyKey = async (): Promise<boolean> => {
    try {
      const { data } = await api.post('/settings/master-password/verify', { password: masterKey.trim() })
      if (!data?.valid) { message.error('Master password không khớp'); return false }
      return true
    } catch {
      message.error('Không xác thực được master password'); return false
    }
  }

  // Draw the first image (original + processed) into the preview canvases.
  // Scramble mode: uses an illustrative "masterKey:preview" key just to show the grid
  // effect. Unscramble mode: reads the real slug+grid from manifest.json and reverses
  // the first image of the first chapter — a genuine check that the key unlocks it.
  const doPreview = async () => {
    if (!masterKey.trim()) { message.warning('Vui lòng nhập master key'); return }
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
        perm = generatePermutation(`${masterKey.trim()}:preview`, g)
      } else {
        const manifest = await readManifest(inputDir).catch(() => null)
        if (!manifest || manifest.length === 0) { message.warning('Không đọc được manifest.json'); return }
        const entry = manifest[0]
        g = entry.grid
        const chapterDir = await inputDir.getDirectoryHandle(entry.slug)
        const files = await readImageFiles(chapterDir)
        if (files.length === 0) { message.warning('Chapter đầu tiên không có ảnh'); return }
        fileHandle = files[0].handle
        perm = generateInversePermutation(`${masterKey.trim()}:${entry.slug}`, g)
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

  const runScramble = async () => {
    // Determine chapters: direct subfolders, or the input folder itself if it holds images directly.
    const subDirs = await readSubDirs(inputDir!)
    const chapters: { name: string; handle: FileSystemDirectoryHandle }[] =
      subDirs.length > 0 ? subDirs : [{ name: inputDir!.name, handle: inputDir! }]

    // Pre-count total files for the progress bar.
    const chapterFiles: { name: string; handle: FileSystemDirectoryHandle; files: { name: string; handle: FileSystemFileHandle }[] }[] = []
    let grandTotal = 0
    for (const ch of chapters) {
      const files = await readImageFiles(ch.handle)
      if (files.length === 0) continue
      chapterFiles.push({ ...ch, files })
      grandTotal += files.length
    }
    setTotal(grandTotal)
    if (grandTotal === 0) { message.warning('Không tìm thấy ảnh trong folder'); return }

    // For Drive destination, create one run root folder that holds every chapter
    // subfolder + the manifest. Sharing this root with the service account cascades
    // read access to all children, so /api/images can proxy the tiles.
    let driveRootId: string | null = null
    if (dest === 'drive') {
      const runName = `scramble-${new Date().toISOString().replace(/[:.]/g, '-')}`
      driveRootId = await createDriveFolder(runName)
    }

    const manifest: ChapterManifestEntry[] = []
    let processed = 0
    startedRef.current = Date.now()

    for (const ch of chapterFiles) {
      if (cancelledRef.current) break
      const slug = newSlug()
      const key = `${masterKey.trim()}:${slug}`
      setCurrentLabel(`${ch.name} → ${slug}`)

      // Output target for this chapter: a local dir handle, or a Drive folder id.
      const outChapterDir = dest === 'local'
        ? await outputDir!.getDirectoryHandle(slug, { create: true })
        : null
      const driveChapterId = dest === 'drive'
        ? await createDriveFolder(slug, driveRootId!)
        : null

      // Pair each file with its 1-based sequence up front, so output names stay
      // stable (001.png, 002.png…) even when uploads finish out of order.
      const numbered = ch.files.map((file, i) => ({ file, seq: i + 1 }))

      const processOne = async ({ file, seq }: { file: { name: string; handle: FileSystemFileHandle }; seq: number }) => {
        if (cancelledRef.current) return
        const blob = await file.handle.getFile()
        const bitmap = await createImageBitmap(blob)
        try {
          const perm = generatePermutation(key, grid)
          const outBlob = await processToBlob(bitmap, perm, grid)
          const fileName = `${String(seq).padStart(3, '0')}.png`
          if (dest === 'local') {
            const fileHandle = await outChapterDir!.getFileHandle(fileName, { create: true })
            const writable = await fileHandle.createWritable()
            await writable.write(outBlob)
            await writable.close()
          } else {
            await uploadDriveFile(fileName, outBlob, driveChapterId!)
          }
        } finally {
          bitmap.close()
        }
        // JS is single-threaded; these increments run synchronously after each
        // await, so no race even with several uploads in flight.
        processed++
        setDone(processed)
      }

      // Local writes hit disk serially; Drive uploads are network-bound, so run
      // several at once to hide round-trip latency on large chapters.
      if (dest === 'drive') {
        await runPool(numbered, DRIVE_CONCURRENCY, processOne)
      } else {
        for (const item of numbered) {
          if (cancelledRef.current) break
          await processOne(item)
        }
      }
      manifest.push({ original: ch.name, slug, grid, fileCount: ch.files.length })
    }

    if (cancelledRef.current) { message.info('Đã hủy'); return }

    const manifestJson = JSON.stringify(manifest, null, 2)
    if (dest === 'local') {
      const manifestHandle = await outputDir!.getFileHandle('manifest.json', { create: true })
      const manifestWritable = await manifestHandle.createWritable()
      await manifestWritable.write(manifestJson)
      await manifestWritable.close()
    } else {
      await uploadDriveFile('manifest.json', new Blob([manifestJson], { type: 'application/json' }), driveRootId!)
      // Grant the read-only service account access so /api/images can serve tiles.
      if (serviceEmail) await shareWithServiceAccount(driveRootId!, serviceEmail)
    }

    message.success(
      dest === 'drive'
        ? `Hoàn thành! ${manifest.length} chapter, ${processed} ảnh đã xáo & upload lên Drive.`
        : `Hoàn thành! ${manifest.length} chapter, ${processed} ảnh đã xáo.`
    )
  }

  const runUnscramble = async () => {
    // Reads <input>/manifest.json; for each entry, key = masterKey:slug + entry.grid
    // restores <input>/<slug>/* back to <output>/<original>/NNN.png.
    const manifest = await readManifest(inputDir!).catch(() => null)
    if (!manifest || manifest.length === 0) {
      message.error('Không tìm thấy manifest.json trong folder input. Unscramble cần folder output do tool tạo ra.')
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
      const key = `${masterKey.trim()}:${entry.slug}`
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
    if (!isPwSet) { message.warning('Vui lòng đặt master password trước'); return }
    if (!masterKey.trim()) { message.warning('Vui lòng nhập master key'); return }
    if (!inputDir) { message.warning('Vui lòng chọn folder input'); return }
    // Unscramble always writes local. Scramble writes local OR to Drive.
    const toDrive = mode === 'scramble' && dest === 'drive'
    if (!toDrive && !outputDir) { message.warning('Vui lòng chọn folder output'); return }
    if (toDrive && !driveEmail) { message.warning('Vui lòng kết nối Google Drive trước'); return }
    if (toDrive && !serviceEmail) { message.warning('Chưa lấy được service account email, thử lại sau'); return }
    if (!(await verifyKey())) return

    cancelledRef.current = false
    setRunning(true)
    setDone(0)
    setTotal(0)
    setCurrentLabel('Đang quét folder...')

    try {
      if (mode === 'scramble') await runScramble()
      else await runUnscramble()
    } catch (e) {
      message.error(`Lỗi: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setRunning(false)
      setCurrentLabel('')
    }
  }

  const cancel = () => { cancelledRef.current = true }

  const supported = typeof window !== 'undefined' && 'showDirectoryPicker' in window

  return (
    <>
      <h2 style={{ fontSize: 16, fontWeight: 600, marginBottom: 12 }}>Scramble ảnh</h2>

      {!supported && (
        <div style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 12, padding: 16, marginBottom: 16, color: 'var(--text-muted)', fontSize: 13 }}>
          Trình duyệt không hỗ trợ File System Access API. Vui lòng dùng Chrome hoặc Edge trên desktop.
        </div>
      )}

      {/* Master password: set once (hash stored server-side), then required to
          match on every run so a mistyped key can't produce garbage. */}
      {!pwStatusLoading && (
        <div style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 12, padding: 16, marginBottom: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
            <span className="ms" style={{ fontSize: 18, color: 'var(--accent)' }}>lock</span>
            <span style={{ fontSize: 14, fontWeight: 600 }}>{isPwSet ? 'Đổi master password' : 'Đặt master password'}</span>
          </div>
          <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12 }}>
            {isPwSet
              ? 'Master password đã được đặt. Nhập master key đúng với mật khẩu này để scramble/unscramble.'
              : 'Đặt master password trước khi scramble. Hash lưu ở server chỉ để kiểm tra bạn gõ đúng, không giải mã được.'}
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {isPwSet && (
              <Input.Password
                value={pwCurrent}
                onChange={e => setPwCurrent(e.target.value)}
                placeholder="Master password hiện tại"
                disabled={pwSaving}
              />
            )}
            <Input.Password
              value={pwNew}
              onChange={e => setPwNew(e.target.value)}
              placeholder={isPwSet ? 'Master password mới' : 'Master password'}
              disabled={pwSaving}
            />
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <Button type="primary" onClick={savePassword} loading={pwSaving} style={{ borderRadius: 20, height: 36 }}>
                {isPwSet ? 'Đổi' : 'Đặt'}
              </Button>
            </div>
          </div>
        </div>
      )}

      <div style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 12, padding: 16 }}>
        <Segmented
          value={mode}
          onChange={v => { setMode(v as Mode); setPreviewReady(false) }}
          disabled={running}
          options={[
            { label: 'Scramble (xáo)', value: 'scramble' },
            { label: 'Unscramble (khôi phục)', value: 'unscramble' },
          ]}
          style={{ marginBottom: 12 }}
        />

        <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 16 }}>
          {mode === 'scramble'
            ? 'Xáo ảnh local trước khi upload. Mỗi thư mục con = 1 chapter, xáo bằng key riêng (masterKey:slug). Kết quả ghi PNG kèm manifest.json.'
            : 'Khôi phục ảnh đã xáo. Folder input phải chứa manifest.json (do tool scramble tạo). Kết quả ghi ra <output>/<tên chapter gốc>/NNN.png.'}
        </p>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div>
            <label style={{ fontSize: 13, fontWeight: 500, display: 'block', marginBottom: 6 }}>Master key</label>
            <Input.Password
              value={masterKey}
              onChange={e => { setMasterKey(e.target.value); setPreviewReady(false) }}
              placeholder="Nhập master key (không lưu)"
              disabled={running}
            />
          </div>

          {mode === 'scramble' && (
            <div>
              <label style={{ fontSize: 13, fontWeight: 500, display: 'block', marginBottom: 6 }}>Grid</label>
              <Select
                value={grid}
                onChange={v => { setGrid(v); setPreviewReady(false) }}
                disabled={running}
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
                disabled={running}
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
                <Button onClick={() => connectDriveAccount(false)} loading={driveConnecting} disabled={running} style={{ borderRadius: 20, height: 34 }}>
                  <span className="ms ms-sm">login</span> {driveEmail ? 'Kết nối lại' : 'Kết nối Drive'}
                </Button>
                <Button onClick={() => connectDriveAccount(true)} disabled={running || driveConnecting} style={{ borderRadius: 20, height: 34 }}>
                  <span className="ms ms-sm">switch_account</span> Đổi tài khoản
                </Button>
                {driveEmail && (
                  <Button onClick={disconnectDriveAccount} disabled={running} danger style={{ borderRadius: 20, height: 34 }}>
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

          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <Button onClick={pickInput} disabled={running || !supported} style={{ borderRadius: 20, height: 36 }}>
              <span className="ms ms-sm">folder_open</span> {inputDir ? `Input: ${inputDir.name}` : 'Chọn folder input'}
            </Button>
            {!(mode === 'scramble' && dest === 'drive') && (
              <Button onClick={pickOutput} disabled={running || !supported} style={{ borderRadius: 20, height: 36 }}>
                <span className="ms ms-sm">drive_folder_upload</span> {outputDir ? `Output: ${outputDir.name}` : 'Chọn folder output'}
              </Button>
            )}
            <Button onClick={doPreview} loading={previewing} disabled={running || !supported} style={{ borderRadius: 20, height: 36 }}>
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
              Preview dùng khóa minh hoạ ":preview" — slug thật sinh ngẫu nhiên khi chạy, nên ảnh xáo thực tế sẽ khác.
            </p>
          )}

          {running && (() => {
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
            {running && <Button onClick={cancel} danger style={{ borderRadius: 20, height: 36 }}>Hủy</Button>}
            <Button type="primary" onClick={start} loading={running} disabled={!supported} style={{ borderRadius: 20, height: 36 }}>
              {mode === 'scramble' ? 'Bắt đầu xáo' : 'Bắt đầu khôi phục'}
            </Button>
          </div>
        </div>
      </div>
    </>
  )
}
