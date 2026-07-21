import { useEffect, useRef, useState } from 'react'
import { Input, Button, Progress, Select, Segmented, message } from 'antd'
import { generatePermutation, generateInversePermutation, deriveChapterKey } from '../../lib/scramble'
import api from '../../lib/api'
import { connectDrive, disconnectDrive, createDriveFolder, uploadDriveFile, shareWithServiceAccount, pickDriveFolder, findChildByName, downloadDriveFileText, updateDriveFileContent, trashDriveFile, abortAllDriveRequests, DRIVE_FOLDER_MIME } from '../../lib/googleDrive'

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
// when every item finishes. Once any worker throws, no runner picks up a new
// item, but items already in flight are allowed to finish first — this keeps
// other uploads from racing a chapter-folder trash triggered by the error.
// The first error is re-thrown once every runner has settled.
async function runPool<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  let next = 0
  let failed = false
  let firstError: unknown = null
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length && !failed) {
      const i = next++
      try {
        await worker(items[i])
      } catch (e) {
        failed = true
        if (firstError === null) firstError = e
      }
    }
  })
  await Promise.all(runners)
  if (failed) throw firstError
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

// Read files sitting directly at the manga-folder root (metadata.json, cover,
// banner...). These are copied verbatim into the scrambled output so it becomes a
// self-contained manga folder that sync ingests unchanged — title/cover intact.
// Chapter images live in subfolders, not here, so this never picks up page images.
async function readRootFiles(dir: FileSystemDirectoryHandle): Promise<{ name: string; handle: FileSystemFileHandle }[]> {
  const files: { name: string; handle: FileSystemFileHandle }[] = []
  for await (const [name, handle] of dir.entries()) {
    if (handle.kind === 'file') {
      files.push({ name, handle: handle as FileSystemFileHandle })
    }
  }
  return files
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
  return parseManifestStrict(text)
}

function isValidManifestEntry(e: unknown): e is ChapterManifestEntry {
  if (typeof e !== 'object' || e === null) return false
  const r = e as Record<string, unknown>
  return typeof r.original === 'string' && r.original.trim().length > 0 &&
    typeof r.slug === 'string' && r.slug.trim().length > 0 &&
    typeof r.grid === 'number' && Number.isInteger(r.grid) && r.grid > 1 &&
    typeof r.fileCount === 'number' && Number.isInteger(r.fileCount) && r.fileCount >= 0
}

function parseManifestStrict(text: string): ChapterManifestEntry[] {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    throw new Error('manifest.json không phải JSON hợp lệ')
  }
  if (!Array.isArray(data)) throw new Error('manifest.json phải là một JSON array')
  for (let i = 0; i < data.length; i++) {
    const entry = data[i]
    if (!isValidManifestEntry(entry)) {
      throw new Error(`manifest.json có entry #${i + 1} không hợp lệ: original/slug phải khác rỗng, grid phải là số nguyên > 1 và fileCount phải là số nguyên >= 0`)
    }
  }
  return data as ChapterManifestEntry[]
}

// Returns the first key that appears twice, or null if all keys are unique.
// Used to reject an append target whose manifest has ambiguous entries before
// touching Drive.
function findDuplicateKey(entries: ChapterManifestEntry[], keyFn: (e: ChapterManifestEntry) => string): string | null {
  const seen = new Set<string>()
  for (const entry of entries) {
    const k = keyFn(entry)
    if (seen.has(k)) return k
    seen.add(k)
  }
  return null
}

// Copy the non-image files sitting directly at the input root (metadata.json,
// cover/banner images referenced by it) verbatim into the Drive manga folder, so
// sync's ApplyMetadata keeps the manga's title/cover. Chapter pages live in slug
// subfolders; anything loose at the root is metadata to carry over. We upload the
// original bytes (no scramble) — cover/banner are served as-is by /api/images.
async function copyRootFilesToDrive(inputDir: FileSystemDirectoryHandle, driveMangaId: string): Promise<void> {
  for await (const [name, handle] of inputDir.entries()) {
    if (handle.kind !== 'file' || name === 'manifest.json') continue
    const blob = await (handle as FileSystemFileHandle).getFile()
    await uploadDriveFile(name, blob, driveMangaId)
  }
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
  // Drive scramble target: a brand-new manga (create run root + manga folder) or
  // append new chapters into an EXISTING manga folder picked via Google Picker.
  const [driveMode, setDriveMode] = useState<'new' | 'append'>('new')
  const [driveTarget, setDriveTarget] = useState<{ id: string; name: string } | null>(null)
  const [picking, setPicking] = useState(false)
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
  // Scramble mode derives an illustrative HMAC key from a fixed preview slug,
  // following the same Phase 2 pipeline as a real randomly generated slug.
  // Unscramble mode reads the real slug+grid from manifest.json and reverses
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
        perm = generatePermutation(await deriveChapterKey(masterKey.trim(), 'chapter-preview'), g)
      } else {
        const manifest = await readManifest(inputDir)
        if (manifest.length === 0) { message.warning('manifest.json không có chapter'); return }
        const entry = manifest[0]
        g = entry.grid
        const chapterDir = await inputDir.getDirectoryHandle(entry.slug)
        const files = await readImageFiles(chapterDir)
        if (files.length === 0) { message.warning('Chapter đầu tiên không có ảnh'); return }
        fileHandle = files[0].handle
        perm = generateInversePermutation(await deriveChapterKey(masterKey.trim(), entry.slug), g)
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

    // Collect chapters that actually contain images.
    const chapterFiles: { name: string; handle: FileSystemDirectoryHandle; files: { name: string; handle: FileSystemFileHandle }[] }[] = []
    for (const ch of chapters) {
      const files = await readImageFiles(ch.handle)
      if (files.length === 0) continue
      chapterFiles.push({ ...ch, files })
    }
    if (chapterFiles.length === 0) { message.warning('Không tìm thấy ảnh trong folder'); return }

    if (dest === 'local') {
      await runScrambleLocal(chapterFiles)
      return
    }

    await runScrambleDrive(chapterFiles)
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
    let processed = 0
    startedRef.current = Date.now()

    for (const ch of chapterFiles) {
      if (cancelledRef.current) break
      const slug = newSlug()
      const key = await deriveChapterKey(masterKey.trim(), slug)
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
      manifest.push({ original: ch.name, slug, grid, fileCount: ch.files.length })
    }

    if (cancelledRef.current) { message.info('Đã hủy'); return }

    const manifestHandle = await outputDir!.getFileHandle('manifest.json', { create: true })
    const manifestWritable = await manifestHandle.createWritable()
    await manifestWritable.write(JSON.stringify(manifest, null, 2))
    await manifestWritable.close()

    message.success(`Hoàn thành! ${manifest.length} chapter, ${processed} ảnh đã xáo.`)
  }

  // Drive scramble: checkpoints manifest.json after every chapter so a failed or
  // cancelled run can be safely re-run — chapters already checkpointed (same
  // `original` + `fileCount`, and their slug folder still present) are skipped
  // instead of being re-uploaded under a new slug.
  const runScrambleDrive = async (
    chapterFiles: { name: string; handle: FileSystemDirectoryHandle; files: { name: string; handle: FileSystemFileHandle }[] }[],
  ) => {
    // Drive output must mirror the sync folder concept so sync ingests it with NO
    // code change.
    //  - 'new':    <run root>/<manga name>/<slug chapter>/NNN.png  (fresh manga)
    //  - 'append': <picked manga folder>/<slug chapter>/NNN.png    (existing manga)
    // In append mode the picked folder IS the manga folder (its DriveFileId is
    // already in the DB from the first sync), so new slug subfolders land beside the
    // old ones and sync picks them up as new chapters. shareThisId is what we grant
    // the service account: the run root ('new') cascades to children; in 'append'
    // the manga folder is already shared.
    const appendMode = driveMode === 'append'
    let driveMangaId: string
    let shareThisId: string
    let manifestFileId: string
    let existingEntries: ChapterManifestEntry[] = []

    if (appendMode) {
      driveMangaId = driveTarget!.id
      shareThisId = driveTarget!.id
      const existingId = await findChildByName(driveMangaId, 'manifest.json')
      if (!existingId) {
        throw new Error('Không tìm thấy manifest.json trong manga đích — chỉ có thể thêm chapter vào manga do chính tool này scramble trước đó.')
      }
      existingEntries = parseManifestStrict(await downloadDriveFileText(existingId))
      const dupOriginal = findDuplicateKey(existingEntries, e => e.original)
      if (dupOriginal) throw new Error(`manifest.json trên Drive có nhiều entry cùng tên chapter "${dupOriginal}" — không rõ entry nào đúng, dừng lại để tránh ghi đè sai.`)
      const dupSlug = findDuplicateKey(existingEntries, e => e.slug)
      if (dupSlug) throw new Error(`manifest.json trên Drive có nhiều entry cùng slug "${dupSlug}" — dừng lại để tránh ghi đè sai.`)
      manifestFileId = existingId
    } else {
      const runName = `scramble-${new Date().toISOString().replace(/[:.]/g, '-')}`
      const driveRootId = await createDriveFolder(runName)
      driveMangaId = await createDriveFolder(inputDir!.name, driveRootId)
      shareThisId = driveRootId
      // Checkpoint file created up front (empty array) so every chapter update
      // below is a PATCH to a stable file id, never a fresh upload.
      manifestFileId = await uploadDriveFile('manifest.json', new Blob([JSON.stringify([], null, 2)], { type: 'application/json' }), driveMangaId)
      // Copy the non-image root files (metadata.json, cover/banner) verbatim so the
      // synced manga keeps its title/cover. Chapter images live in slug subfolders,
      // so anything at the input root is metadata to carry over.
      await copyRootFilesToDrive(inputDir!, driveMangaId)
    }

    // Preflight: decide which chapters are already checkpointed vs. need upload.
    // A chapter is considered done only if the manifest entry's fileCount matches
    // the current input AND its slug folder is still actually present on Drive —
    // a stale entry pointing at a deleted folder must not be trusted as "done".
    const byOriginal = new Map(existingEntries.map(e => [e.original, e]))
    const plan: { ch: typeof chapterFiles[number]; skip: boolean }[] = []
    for (let i = 0; i < chapterFiles.length; i++) {
      const ch = chapterFiles[i]
      setCurrentLabel(`Đang kiểm tra "${ch.name}" đã upload chưa... (${i + 1}/${chapterFiles.length})`)
      const existing = byOriginal.get(ch.name)
      if (!existing) {
        plan.push({ ch, skip: false })
        continue
      }
      if (existing.fileCount !== ch.files.length) {
        throw new Error(`Chapter "${ch.name}" đã có trong manifest (${existing.fileCount} ảnh) nhưng folder input hiện có ${ch.files.length} ảnh. Chưa hỗ trợ thay thế chapter đã upload — cần xử lý thủ công.`)
      }
      const folderId = await findChildByName(driveMangaId, existing.slug, DRIVE_FOLDER_MIME)
      if (!folderId) {
        throw new Error(`Chapter "${ch.name}" có entry trong manifest (slug ${existing.slug}) nhưng folder đó không còn trên Drive. Dừng lại — cần kiểm tra thủ công.`)
      }
      plan.push({ ch, skip: true })
    }

    const skippedCount = plan.filter(p => p.skip).length
    const grandTotal = plan.filter(p => !p.skip).reduce((sum, p) => sum + p.ch.files.length, 0)
    setTotal(grandTotal)
    if (skippedCount > 0) setCurrentLabel(`Bỏ qua ${skippedCount} chapter đã có trên Drive...`)

    let processed = 0
    const manifestEntries = [...existingEntries]
    // Chapters that failed to upload — collected instead of aborting the whole
    // run, so one bad chapter (e.g. a corrupt image) doesn't block the rest.
    const failedChapters: { name: string; error: string }[] = []
    // A handful of isolated failures (bad image, transient hiccup) shouldn't
    // stop the run. But failures in a row usually mean something systemic —
    // wrong master key, network down, Drive quota — and blindly ploughing
    // through the rest of the plan just repeats the same failure N times while
    // burning Drive quota on create+trash. Stop early in that case.
    const MAX_CONSECUTIVE_FAILURES = 3
    let consecutiveFailures = 0
    let stoppedByConsecutiveFailures = false
    startedRef.current = Date.now()

    for (const item of plan) {
      if (item.skip) continue
      if (cancelledRef.current) break

      const ch = item.ch
      const slug = newSlug()
      const key = await deriveChapterKey(masterKey.trim(), slug)
      setCurrentLabel(`${ch.name} → ${slug}`)

      try {
        const driveChapterId = await createDriveFolder(slug, driveMangaId)

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
            await uploadDriveFile(fileName, outBlob, driveChapterId)
          } finally {
            bitmap.close()
          }
          // JS is single-threaded; these increments run synchronously after each
          // await, so no race even with several uploads in flight.
          processed++
          setDone(processed)
        }

        try {
          await runPool(numbered, DRIVE_CONCURRENCY, processOne)
        } catch (e) {
          // Upload failed partway through this chapter — the folder is incomplete
          // and has no manifest entry. Trash it so a re-run doesn't leave an orphan
          // for sync to pick up, and doesn't collide if the admin retries.
          await trashDriveFile(driveChapterId).catch(cleanupErr => {
            message.error(`Không tự xóa được folder dở "${slug}" trên Drive, cần xóa tay: ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}`)
          })
          throw e
        }

        if (cancelledRef.current) {
          // Cancelled mid-chapter: same as a failure — no manifest entry, best-effort
          // trash the partial folder so it isn't left as an unmanifested orphan.
          await trashDriveFile(driveChapterId).catch(cleanupErr => {
            message.error(`Không tự xóa được folder dở "${slug}" trên Drive, cần xóa tay: ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}`)
          })
          break
        }

        // Checkpoint: this chapter is fully uploaded, record it in the manifest and
        // persist immediately so a later chapter's failure can't lose this progress.
        manifestEntries.push({ original: ch.name, slug, grid, fileCount: ch.files.length })
        await updateDriveFileContent(manifestFileId, new Blob([JSON.stringify(manifestEntries, null, 2)], { type: 'application/json' }))
        consecutiveFailures = 0
      } catch (e) {
        // Record the failure and move on to the next chapter instead of
        // aborting the entire run — one bad chapter shouldn't block the rest.
        failedChapters.push({ name: ch.name, error: e instanceof Error ? e.message : String(e) })
        consecutiveFailures++
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          stoppedByConsecutiveFailures = true
          break
        }
      }
    }

    // Share the target even if every chapter was skipped, failed, or the run
    // was cancelled partway — whatever got checkpointed above must still be readable.
    if (serviceEmail) {
      await shareWithServiceAccount(shareThisId, serviceEmail)
      // For "manga mới" this is a brand-new top-level Drive folder the backend has
      // never seen — without this it stays invisible in Drive Source until
      // AutoSyncService's 30-minute timer (or a server restart) happens to run.
      // Best-effort: a failure here just means the admin waits for the timer instead.
      await api.post('/admin/root-folders/detect-new-shared').catch(() => {})
    }

    const newCount = manifestEntries.length - existingEntries.length
    if (cancelledRef.current) {
      message.info(`Đã hủy. ${newCount} chapter mới đã checkpoint (${processed} ảnh) — chạy lại sẽ bỏ qua các chapter này.`)
      return
    }

    if (failedChapters.length > 0) {
      message.error(
        (stoppedByConsecutiveFailures
          ? `Dừng sớm vì ${MAX_CONSECUTIVE_FAILURES} chapter liên tiếp lỗi (có thể do master key sai, mất mạng, hoặc hết quota Drive) — kiểm tra rồi chạy lại. `
          : 'Hoàn thành với lỗi. ')
        + `${newCount} chapter mới (${processed} ảnh) đã upload thành công`
        + (skippedCount > 0 ? `, bỏ qua ${skippedCount} chapter đã có` : '')
        + `. ${failedChapters.length} chapter LỖI, cần chạy lại: `
        + failedChapters.map(f => `"${f.name}" (${f.error})`).join('; ')
      , 12)
      return
    }

    message.success(
      `Hoàn thành! ${newCount} chapter mới (${processed} ảnh) đã xáo & upload lên Drive.`
      + (skippedCount > 0 ? ` Bỏ qua ${skippedCount} chapter đã có.` : '')
    )
  }

  const runUnscramble = async () => {
    // Reads <input>/manifest.json; for each entry, key = HMAC(masterKey, slug) + entry.grid
    // restores <input>/<slug>/* back to <output>/<original>/NNN.png.
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
      const key = await deriveChapterKey(masterKey.trim(), entry.slug)
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
    if (toDrive && driveMode === 'append' && !driveTarget) { message.warning('Vui lòng chọn manga đích để thêm chapter'); return }
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

  const cancel = () => {
    cancelledRef.current = true
    // A stalled Drive request never rejects on its own (see driveFetch), so
    // the cancel flag alone can't unstick a run that's frozen mid-await —
    // abort whatever's in flight so control actually returns to the loop.
    abortAllDriveRequests()
  }

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
            ? 'Xáo ảnh local trước khi upload. Mỗi thư mục con = 1 chapter, dùng khóa riêng dẫn xuất bằng HMAC-SHA256(master key, slug). Kết quả ghi PNG kèm manifest.json.'
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
                disabled={running}
                options={[
                  { label: 'Manga mới', value: 'new' },
                  { label: 'Thêm chapter vào manga có sẵn', value: 'append' },
                ]}
                style={{ marginBottom: driveMode === 'append' ? 8 : 0 }}
              />
              {driveMode === 'append' && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <Button onClick={pickTargetFolder} loading={picking} disabled={running || !driveEmail} style={{ borderRadius: 20, height: 34 }}>
                    <span className="ms ms-sm">folder_special</span> {driveTarget ? `Manga: ${driveTarget.name}` : 'Chọn manga đích'}
                  </Button>
                  <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                    Chỉ chọn folder manga đã scramble trước đó (chứa manifest.json).
                  </span>
                </div>
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
              Preview dùng slug cố định "chapter-preview" với cùng HMAC-SHA256 như Phase 2; slug thật sinh ngẫu nhiên khi chạy nên ảnh xáo thực tế sẽ khác.
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
