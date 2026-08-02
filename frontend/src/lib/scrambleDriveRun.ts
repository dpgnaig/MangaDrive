// Module-level store + orchestration for the "scramble -> upload to Drive" run.
//
// This lives outside React on purpose: AdminScrambleTab is unmounted whenever
// the admin switches admin tabs or navigates to another route (see Admin.tsx /
// App.tsx), which used to discard all upload-run state and strand the
// in-flight Promise chain (its `await` continuations kept firing, but the
// setState calls they made landed on a dead component). Module scope survives
// client-side navigation, so keeping the run's state and control loop here
// lets it finish regardless of what's currently mounted — the same pattern
// googleDrive.ts already uses for the Drive access token.
//
// AdminScrambleTab subscribes to this store via useSyncExternalStore instead
// of owning any of this state itself.
import { message } from 'antd'
import api from './api'
import { generatePermutation } from './scramble'
import {
  createDriveFolder, uploadDriveFile, shareWithServiceAccount, findChildByName,
  downloadDriveFileText, updateDriveFileContent, trashDriveFile, abortAllDriveRequests,
  findOrCreateMangaRootFolder, DRIVE_FOLDER_MIME,
} from './googleDrive'
import {
  type ChapterManifestEntry, type ScrambleChapterFiles, type Mutex,
  createMutex, runPool, newSlug, deriveChapterKey, processToBlob, parseManifestStrict,
} from './scrambleFiles'

// Per-chapter row state for the Drive upload progress list. Keyed by `name`
// (the original chapter folder name — stable across retries, unlike `slug`
// which is only assigned once upload actually starts).
export type ChapterRunStatus = 'pending' | 'skipped' | 'uploading' | 'done' | 'error' | 'cancelled'

export interface ChapterRunState {
  name: string
  fileCount: number
  status: ChapterRunStatus
  doneCount: number
  slug?: string
  error?: string
  // True while the row is playing its fade-out transition, just before it's
  // removed from chapterRuns — see scheduleAutoHide.
  fadingOut?: boolean
}

// Run-scoped context shared across every chapter worker, kept alive at module
// scope so Retry can reuse it even after the initial run's Promise.all has resolved.
interface DriveRunContext {
  driveMangaId: string
  manifestFileId: string
  manifestEntries: ChapterManifestEntry[]
  usedSlugs: Set<string>
  shareThisId: string
  // Natural-sort position of every chapter in the current input folder, keyed by
  // original folder name — written into each manifest entry's `order` field.
  chapterOrder: Map<string, number>
  slugMutex: Mutex
  manifestMutex: Mutex
}

// How many images within a chapter upload concurrently. Total concurrent Drive
// requests ≈ chapterConcurrency (admin-selectable) × IMAGE_CONCURRENCY.
const IMAGE_CONCURRENCY = 2

// A handful of isolated chapter failures (bad image, transient hiccup)
// shouldn't stop the run. But failures in a row usually mean something
// systemic — server unavailable, network down, Drive quota exhausted — and
// blindly ploughing through the rest just repeats the same failure. Instead of
// aborting, the pool auto-pauses and waits for the admin to hit "Tiếp tục".
const MAX_CONSECUTIVE_FAILURES = 3

// The Drive upload list only needs to show what's actively in flight (plus
// pending/error rows the admin still needs to act on) — done/skipped/cancelled
// rows fade out and are removed after a short delay instead of piling up.
const AUTO_HIDE_DELAY_MS = 1500
const AUTO_HIDE_FADE_MS = 350

export interface DriveRunSnapshot {
  running: boolean
  done: number
  total: number
  currentLabel: string
  // Set once the "already on Drive?" preflight check finishes, so the UI can
  // show a distinct green-check result line instead of leaving the last
  // "checking (n/n)" progress text stuck on screen through the whole upload.
  // Cleared at the start of the next run.
  checkedSummary: string | null
  chapterRuns: ChapterRunState[]
  pausedInfo: string | null
  startedAt: number
}

// ---- module-level state (replaces the component's refs/useState) ----
let running = false
let done = 0
let total = 0
let currentLabel = ''
let checkedSummary: string | null = null
let chapterRuns: ChapterRunState[] = []
let pausedInfo: string | null = null
let startedAt = 0

let cancelled = false
let driveRunCtx: DriveRunContext | null = null
let allChapterFiles: ScrambleChapterFiles[] = []
const chapterControllers = new Map<string, AbortController>()
let paused = false
let resumeWaiters: (() => void)[] = []
// Consecutive chapter failures across the current pool run (reset on any
// success). Shared across concurrent workers — see processChapter.
let consecutiveFailures = 0
const autoHideTimers = new Map<string, ReturnType<typeof setTimeout>[]>()

let snapshot: DriveRunSnapshot = buildSnapshot()
const listeners = new Set<() => void>()

function buildSnapshot(): DriveRunSnapshot {
  return { running, done, total, currentLabel, checkedSummary, chapterRuns, pausedInfo, startedAt }
}

function emit() {
  snapshot = buildSnapshot()
  for (const l of listeners) l()
}

export function subscribeDriveRun(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function getDriveRunSnapshot(): DriveRunSnapshot {
  return snapshot
}

// True while a run is active, or has finished but left error rows the admin
// still needs to retry (chapterRuns only clears finished rows via
// scheduleAutoHide — error rows stay until retried). AdminScrambleTab is
// unmounted whenever the admin switches admin tabs or navigates elsewhere
// (see Admin.tsx), which used to reset its local UI state (mode/dest/grid/
// driveMode/driveTarget) back to defaults even though this store's run kept
// going — this lets both AdminScrambleTab and Admin.tsx detect "there's
// Drive-run state worth showing" on mount and restore accordingly.
export function hasActiveOrPendingDriveRun(): boolean {
  return running || chapterRuns.length > 0
}

// ---- helpers ported from AdminScrambleTab.tsx ----

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

// Copy/update the non-image files sitting directly at the input root
// (metadata.json, cover/banner images referenced by it) into the Drive manga
// folder, so sync's ApplyMetadata keeps the manga's title/cover. Chapter pages
// live in slug subfolders; anything loose at the root is metadata to carry
// over. We upload the original bytes (no scramble) — cover/banner are served
// as-is by /api/images. Upserts by name: if the manga folder already has a
// same-named file (re-running "Manga mới" into a folder that already exists
// from an earlier interrupted run), its content is overwritten in place via
// updateDriveFileContent instead of uploading a duplicate alongside it.
async function copyRootFilesToDrive(inputDir: FileSystemDirectoryHandle, driveMangaId: string): Promise<void> {
  for await (const [name, handle] of inputDir.entries()) {
    if (handle.kind !== 'file' || name === 'manifest.json') continue
    const blob = await (handle as FileSystemFileHandle).getFile()
    const existingId = await findChildByName(driveMangaId, name)
    if (existingId) {
      await updateDriveFileContent(existingId, blob)
    } else {
      await uploadDriveFile(name, blob, driveMangaId)
    }
  }
}

// Read + validate an existing manifest.json inside a Drive manga folder, if
// present. Returns null if the folder has no manifest.json yet (e.g. a
// freshly created folder). Shared by "append to existing manga" and by
// "Manga mới" landing on a folder that already exists from an earlier
// interrupted run — both need the same duplicate-entry validation before
// trusting the manifest.
async function readExistingManifest(driveMangaId: string): Promise<{ manifestFileId: string; entries: ChapterManifestEntry[] } | null> {
  const existingId = await findChildByName(driveMangaId, 'manifest.json')
  if (!existingId) return null
  const entries = parseManifestStrict(await downloadDriveFileText(existingId))
  const dupOriginal = findDuplicateKey(entries, e => e.original)
  if (dupOriginal) throw new Error(`manifest.json trên Drive có nhiều entry cùng tên chapter "${dupOriginal}" — không rõ entry nào đúng, dừng lại để tránh ghi đè sai.`)
  const dupSlug = findDuplicateKey(entries, e => e.slug)
  if (dupSlug) throw new Error(`manifest.json trên Drive có nhiều entry cùng slug "${dupSlug}" — dừng lại để tránh ghi đè sai.`)
  return { manifestFileId: existingId, entries }
}

function clearAutoHide(name: string) {
  const timers = autoHideTimers.get(name)
  if (timers) {
    timers.forEach(clearTimeout)
    autoHideTimers.delete(name)
  }
}

// Rows that no longer need admin attention (done/skipped/cancelled) fade out
// and then disappear from the list instead of piling up — only pending,
// uploading, and error rows stay put (error rows need the Retry button).
function scheduleAutoHide(name: string) {
  clearAutoHide(name)
  const fadeTimer = setTimeout(() => {
    updateChapterRun(name, { fadingOut: true })
    const removeTimer = setTimeout(() => {
      autoHideTimers.delete(name)
      chapterRuns = chapterRuns.filter(c => c.name !== name)
      emit()
    }, AUTO_HIDE_FADE_MS)
    autoHideTimers.set(name, [removeTimer])
  }, AUTO_HIDE_DELAY_MS)
  autoHideTimers.set(name, [fadeTimer])
}

// Patch one chapter row by name.
function updateChapterRun(name: string, patch: Partial<ChapterRunState> | ((c: ChapterRunState) => Partial<ChapterRunState>)) {
  chapterRuns = chapterRuns.map(c => c.name === name ? { ...c, ...(typeof patch === 'function' ? patch(c) : patch) } : c)
  emit()
}

function setDone(updater: number | ((d: number) => number)) {
  done = typeof updater === 'function' ? updater(done) : updater
  emit()
}

// Blocks the calling worker until resumeDriveFromPause() is called.
function waitForPauseResume(): Promise<void> {
  return new Promise<void>(res => resumeWaiters.push(res))
}

// Unblocks every worker parked on waitForPauseResume, clears the paused banner,
// and auto-retries the chapters whose failures triggered the pause — without
// this, resuming only lets the queue continue with chapters it hadn't reached
// yet, leaving the ones that caused the pause sitting in 'error' until the
// admin manually hits Retry on each row.
export function resumeDriveFromPause(): void {
  paused = false
  pausedInfo = null
  const waiters = resumeWaiters
  resumeWaiters = []
  emit()
  waiters.forEach(w => w())
  consecutiveFailures = 0
  chapterRuns
    .filter(c => c.status === 'error')
    .forEach(c => { retryDriveChapter(c.name) })
}

// Uploads one chapter end-to-end: assign slug, create its Drive folder, upload
// every image (IMAGE_CONCURRENCY in parallel), checkpoint the manifest, then
// mark the row done. Self-contained — the pool scheduler calls this from the
// queue, and Retry calls it directly for a single chapter after the run has
// "finished". Never throws: every failure path (error, cancel) is recorded on
// the chapter's row instead, so one bad chapter can't reject Promise.all and
// take down sibling workers still uploading other chapters.
async function processChapter(ch: ScrambleChapterFiles, ctx: DriveRunContext, grid: number): Promise<void> {
  const controller = new AbortController()
  chapterControllers.set(ch.name, controller)
  // Retrying a chapter that was already scheduled to fade out (e.g. a fast
  // cancel→retry) must cancel that pending hide, otherwise it can remove
  // the row out from under this fresh attempt.
  clearAutoHide(ch.name)
  updateChapterRun(ch.name, { status: 'uploading', doneCount: 0, error: undefined, fadingOut: false })
  // How many of this chapter's images have been counted toward the aggregate
  // `done` counter so far. If the chapter ends up error/cancelled, its folder
  // gets trashed below and none of those images survive — rolled back in the
  // catch/cancel branches so `done` doesn't overshoot `total` once a retry
  // re-uploads the same images from scratch.
  let chapterDone = 0

  try {
    // Slug assignment must be serialized: two chapters finishing their preflight
    // at nearly the same time could otherwise draw the same random slug before
    // either has added it to usedSlugs.
    const slug = await ctx.slugMutex(() => newSlug(ctx.usedSlugs))
    updateChapterRun(ch.name, { slug })
    const key = await deriveChapterKey(slug)
    const driveChapterId = await createDriveFolder(slug, ctx.driveMangaId, controller.signal)

    // Pair each file with its 1-based sequence up front, so output names stay
    // stable (001.png, 002.png…) even when uploads finish out of order.
    const numbered = ch.files.map((file, i) => ({ file, seq: i + 1 }))
    const processOne = async ({ file, seq }: { file: { name: string; handle: FileSystemFileHandle }; seq: number }) => {
      if (controller.signal.aborted || cancelled) return
      const blob = await file.handle.getFile()
      const bitmap = await createImageBitmap(blob)
      try {
        const perm = generatePermutation(key, grid)
        const outBlob = await processToBlob(bitmap, perm, grid)
        const fileName = `${String(seq).padStart(3, '0')}.png`
        await uploadDriveFile(fileName, outBlob, driveChapterId, controller.signal)
      } finally {
        bitmap.close()
      }
      chapterDone++
      updateChapterRun(ch.name, { doneCount: chapterDone })
      setDone(d => d + 1)
    }

    try {
      await runPool(numbered, IMAGE_CONCURRENCY, processOne)
    } catch (e) {
      // Upload failed partway through — the folder is incomplete and has no
      // manifest entry. Trash it so a retry doesn't leave an orphan for sync
      // to pick up, and doesn't collide with the folder Retry creates next.
      await trashDriveFile(driveChapterId).catch(cleanupErr => {
        message.error(`Không tự xóa được folder dở "${slug}" trên Drive, cần xóa tay: ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}`)
      })
      throw e
    }

    if (controller.signal.aborted || cancelled) {
      await trashDriveFile(driveChapterId).catch(cleanupErr => {
        message.error(`Không tự xóa được folder dở "${slug}" trên Drive, cần xóa tay: ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}`)
      })
      setDone(d => d - chapterDone)
      updateChapterRun(ch.name, { status: 'cancelled' })
      scheduleAutoHide(ch.name)
      return
    }

    // Checkpoint: append + persist the manifest under the mutex so two chapters
    // finishing around the same time can't both read-modify-write and silently
    // drop one entry (lost update).
    await ctx.manifestMutex(async () => {
      // Remove any stale entry for this chapter first — a retry after a
      // prior failed/cancelled attempt could otherwise leave a duplicate
      // (this chapter never got an entry the first time, so normally
      // there's nothing to remove, but this keeps the checkpoint safe if
      // that ever changes).
      const idx = ctx.manifestEntries.findIndex(e => e.original === ch.name)
      const entry: ChapterManifestEntry = { original: ch.name, slug, grid, fileCount: ch.files.length, order: ctx.chapterOrder.get(ch.name) }
      if (idx >= 0) ctx.manifestEntries[idx] = entry
      else ctx.manifestEntries.push(entry)
      await updateDriveFileContent(ctx.manifestFileId, new Blob([JSON.stringify(ctx.manifestEntries, null, 2)], { type: 'application/json' }))
    })
    updateChapterRun(ch.name, { status: 'done', doneCount: ch.files.length })
    scheduleAutoHide(ch.name)
    consecutiveFailures = 0
  } catch (e) {
    // The folder (if any got created) was trashed above — none of this
    // chapter's uploaded-so-far images survive, so undo their contribution
    // to `done` before recording the failure.
    setDone(d => d - chapterDone)
    if (controller.signal.aborted || cancelled) {
      updateChapterRun(ch.name, { status: 'cancelled' })
      scheduleAutoHide(ch.name)
    } else {
      const errMsg = e instanceof Error ? e.message : String(e)
      updateChapterRun(ch.name, { status: 'error', error: errMsg })
      consecutiveFailures++
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES && !paused) {
        paused = true
        pausedInfo = `Tạm dừng: ${MAX_CONSECUTIVE_FAILURES} chapter lỗi liên tiếp (có thể do mất kết nối server, mất mạng, hoặc hết quota Drive). Kiểm tra rồi bấm Tiếp tục.`
        emit()
      }
    }
  } finally {
    chapterControllers.delete(ch.name)
  }
}

// Retry a single failed chapter, reusing the run context + original file scan
// kept alive at module scope — works even after the overall run has
// "finished", since processChapter is fully self-contained. Guarded against
// double-click: the Retry button only renders for 'error' rows, but two rapid
// clicks can both fire before the first status update ('uploading') re-renders,
// which would otherwise start two concurrent uploads for the same chapter (two
// Drive folders, two manifest entries).
export function retryDriveChapter(name: string): void {
  const ctx = driveRunCtx
  const ch = allChapterFiles.find(c => c.name === name)
  if (!ctx || !ch) return
  if (chapterControllers.has(name)) return
  void processChapter(ch, ctx, gridForCurrentRun)
}

// Abort just this chapter's in-flight Drive requests without touching other
// chapters uploading concurrently.
export function cancelDriveChapterRow(name: string): void {
  chapterControllers.get(name)?.abort()
}

export function cancelDriveRun(): void {
  cancelled = true
  // A stalled Drive request never rejects on its own (see driveFetch in
  // googleDrive.ts), so the cancel flag alone can't unstick a run that's
  // frozen mid-await — abort whatever's in flight so control actually
  // returns to the loop.
  abortAllDriveRequests()
  // If the pool is auto-paused, workers are blocked on waitForPauseResume()
  // and only resumeDriveFromPause() wakes them — abortAllDriveRequests() alone
  // can't reach them. Wake them here too so cancel works while paused,
  // otherwise Promise.all in runDrive never resolves and the run
  // hangs forever in the "running" state.
  if (paused) {
    paused = false
    pausedInfo = null
    const waiters = resumeWaiters
    resumeWaiters = []
    emit()
    waiters.forEach(w => w())
  }
}

// grid/driveMode/driveTarget are fixed for the duration of one run (chosen
// before starting); stashed here so retryDriveChapter can reuse the grid
// without threading it through ctx, and so AdminScrambleTab can restore its
// mode/dest/grid/driveMode/driveTarget selects from getLastDriveRunConfig()
// after remounting (e.g. after navigating away mid-run and back) instead of
// resetting to defaults while the run itself keeps going in this module.
let gridForCurrentRun = 6
let driveModeForCurrentRun: 'new' | 'append' = 'new'
let driveTargetForCurrentRun: { id: string; name: string } | null = null

export function getLastDriveRunConfig(): { grid: number; driveMode: 'new' | 'append'; driveTarget: { id: string; name: string } | null } {
  return { grid: gridForCurrentRun, driveMode: driveModeForCurrentRun, driveTarget: driveTargetForCurrentRun }
}

export interface StartDriveRunParams {
  chapterFiles: ScrambleChapterFiles[]
  inputDir: FileSystemDirectoryHandle
  driveMode: 'new' | 'append'
  driveTarget: { id: string; name: string } | null
  grid: number
  serviceEmail: string
  chapterConcurrency: number
}

// Kicks off a Drive scramble run detached from any component — nothing in
// this module depends on a caller staying mounted. Guards against
// double-start: if a run is already in progress, this is a no-op.
export function startDriveRun(params: StartDriveRunParams): void {
  if (running) return
  running = true
  cancelled = false
  done = 0
  total = 0
  currentLabel = 'Đang kiểm tra chapter đã có trên Drive chưa...'
  checkedSummary = null
  pausedInfo = null
  paused = false
  consecutiveFailures = 0
  startedAt = Date.now()
  gridForCurrentRun = params.grid
  driveModeForCurrentRun = params.driveMode
  driveTargetForCurrentRun = params.driveTarget
  emit()

  runDrive(params)
    .catch(e => {
      message.error(`Lỗi: ${e instanceof Error ? e.message : String(e)}`)
    })
    .finally(() => {
      running = false
      currentLabel = ''
      emit()
    })
}

// Drive scramble: checkpoints manifest.json after every chapter so a failed or
// cancelled run can be safely re-run — chapters already checkpointed (same
// `original` + `fileCount`, and their slug folder still present) are skipped
// instead of being re-uploaded under a new slug.
async function runDrive(params: StartDriveRunParams): Promise<void> {
  const { chapterFiles, inputDir, driveMode, driveTarget, grid, serviceEmail, chapterConcurrency } = params

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

  if (appendMode) {
    driveMangaId = driveTarget!.id
    shareThisId = driveTarget!.id
  } else {
    // Reuse one shared "Manga" root across every run instead of a fresh
    // scramble-<timestamp> folder each time — the backend already treats a
    // root as containing many manga subfolders, so this just keeps every new
    // manga landing beside old ones under a single manageable root.
    const driveRootId = await findOrCreateMangaRootFolder()
    // Find-or-create by name too: without this, retrying "Manga mới" after a
    // setup/share failure (or simply running it twice for the same manga)
    // created a second same-named folder under Manga/, which the backend
    // then synced as a duplicate manga. Reusing an existing same-named
    // folder means a re-run continues the same manga instead.
    const existingMangaId = await findChildByName(driveRootId, inputDir.name, DRIVE_FOLDER_MIME)
    driveMangaId = existingMangaId ?? await createDriveFolder(inputDir.name, driveRootId)
    shareThisId = driveRootId
  }

  // Share as early as possible — right after the folder exists, before
  // touching the manifest or uploading a single chapter. The chapter pool
  // below can auto-pause after repeated failures and stay paused
  // indefinitely if the admin never clicks "Tiếp tục" (or just closes the
  // tab), in which case nothing further in this function ever runs. Sharing
  // upfront means the folder — and whatever chapters do get checkpointed —
  // stays visible to the backend's read-only service account even if the
  // run is abandoned, paused forever, or fails during setup right after this.
  if (serviceEmail) {
    await shareWithServiceAccount(shareThisId, serviceEmail)
    if (!appendMode) {
      // Brand-new top-level Drive folder the backend has never seen — without
      // this it stays invisible in Drive Source until AutoSyncService's
      // 30-minute timer (or a server restart) happens to run. Best-effort: a
      // failure here just means the admin waits for the timer instead.
      await api.post('/admin/root-folders/detect-new-shared').catch(() => {})
    }
  }

  // Read/create the manifest checkpoint. Append mode requires one to already
  // exist (its presence is what marks a folder as "created by this tool");
  // "Manga mới" creates one if this is truly a fresh folder, or reuses it if
  // retrying into a folder left over from an earlier interrupted run (see
  // find-or-create above).
  let manifestFileId: string
  let existingEntries: ChapterManifestEntry[] = []
  const existingManifest = await readExistingManifest(driveMangaId)
  if (existingManifest) {
    existingEntries = existingManifest.entries
    manifestFileId = existingManifest.manifestFileId
  } else if (appendMode) {
    throw new Error('Không tìm thấy manifest.json trong manga đích — chỉ có thể thêm chapter vào manga do chính tool này scramble trước đó.')
  } else {
    // Checkpoint file created up front (empty array) so every chapter update
    // below is a PATCH to a stable file id, never a fresh upload.
    manifestFileId = await uploadDriveFile('manifest.json', new Blob([JSON.stringify([], null, 2)], { type: 'application/json' }), driveMangaId)
  }
  // Copy the non-image root files (metadata.json, cover/banner) verbatim so the
  // synced manga keeps its title/cover. Chapter images live in slug subfolders,
  // so anything at the input root is metadata to carry over. Upserts by name,
  // so this is safe to repeat on every run, including retries into an
  // existing folder.
  await copyRootFilesToDrive(inputDir, driveMangaId)

  const usedSlugs = new Set(existingEntries.map(entry => entry.slug))

  // Preflight: decide which chapters are already checkpointed vs. need upload.
  // A chapter is considered done only if the manifest entry's fileCount matches
  // the current input AND its slug folder is still actually present on Drive —
  // a stale entry pointing at a deleted folder must not be trusted as "done".
  const byOriginal = new Map(existingEntries.map(e => [e.original, e]))
  const plan: { ch: ScrambleChapterFiles; skip: boolean }[] = []
  for (let i = 0; i < chapterFiles.length; i++) {
    const ch = chapterFiles[i]
    currentLabel = `Đang kiểm tra chapter đã có trên Drive chưa (${i + 1}/${chapterFiles.length})`
    emit()
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
  const toUpload = plan.filter(p => !p.skip).map(p => p.ch)
  const grandTotal = toUpload.reduce((sum, ch) => sum + ch.files.length, 0)
  total = grandTotal
  // Preflight finished — replace the "checking (n/n)" progress text with a
  // fixed result line so the UI can render it once with a checkmark instead
  // of leaving stale "checking" text on screen through the whole upload.
  currentLabel = ''
  checkedSummary = skippedCount > 0
    ? `Đã kiểm tra ${chapterFiles.length} chapter — bỏ qua ${skippedCount} chapter đã có trên Drive`
    : `Đã kiểm tra ${chapterFiles.length} chapter — chưa có chapter nào trên Drive`
  emit()

  // Populate the per-chapter row list right away — including skipped chapters —
  // so the full chapter list is visible before any upload starts.
  const initialRuns: ChapterRunState[] = plan.map(p => p.skip
    ? { name: p.ch.name, fileCount: p.ch.files.length, status: 'skipped', doneCount: p.ch.files.length }
    : { name: p.ch.name, fileCount: p.ch.files.length, status: 'pending', doneCount: 0 })
  chapterRuns = initialRuns
  allChapterFiles = chapterFiles
  paused = false
  pausedInfo = null
  consecutiveFailures = 0
  emit()
  // Skipped chapters never go through processChapter (the only place that
  // otherwise schedules auto-hide), so schedule it here right away.
  initialRuns.filter(r => r.status === 'skipped').forEach(r => scheduleAutoHide(r.name))

  // Natural-sort position of every chapter in the CURRENT input scan (chapterFiles
  // is already natural-sorted — see readSubDirs/readImageFiles). Chapters upload
  // concurrently below, so the order manifest entries get pushed/checkpointed in
  // is completion order, not this order — every entry needs its `order` written
  // from this map instead of relying on push/array position.
  //
  // In append mode, chapterFiles is only the NEWLY scanned local folder — indexing
  // it from 0 would collide with the order values already assigned to existing
  // manifest entries (also starting at 0), producing two overlapping order ranges
  // and a scrambled chapter list on sync. Offset by the current max existing order
  // + 1 so appended chapters always sort after everything already checkpointed.
  const orderBase = appendMode
    ? existingEntries.reduce((max, e) => Math.max(max, e.order ?? -1), -1) + 1
    : 0
  const chapterOrder = new Map(chapterFiles.map((ch, i) => [ch.name, orderBase + i]))

  const ctx: DriveRunContext = {
    driveMangaId,
    manifestFileId,
    manifestEntries: [...existingEntries],
    usedSlugs,
    shareThisId,
    chapterOrder,
    slugMutex: createMutex(),
    manifestMutex: createMutex(),
  }
  driveRunCtx = ctx

  startedAt = Date.now()
  emit()

  // Chapter-level worker pool: chapterConcurrency chapters upload at once, each
  // internally uploading its images with IMAGE_CONCURRENCY in parallel (see
  // processChapter). A worker parks on waitForPauseResume() between chapters
  // (never mid-chapter) once the pool auto-pauses after too many consecutive
  // failures — chapters already in flight are left to finish normally.
  let queueIndex = 0
  const worker = async () => {
    while (true) {
      if (paused) await waitForPauseResume()
      if (cancelled) return
      const i = queueIndex++
      if (i >= toUpload.length) return
      await processChapter(toUpload[i], ctx, grid)
    }
  }
  await Promise.all(Array.from({ length: Math.min(chapterConcurrency, toUpload.length) }, worker))

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

  const finalRuns = chapterRuns
  const doneChapters = finalRuns.filter(c => c.status === 'done')
  const errorChapters = finalRuns.filter(c => c.status === 'error')
  const cancelledChapters = finalRuns.filter(c => c.status === 'cancelled')
  const uploadedImages = doneChapters.reduce((sum, c) => sum + c.fileCount, 0)

  if (cancelled || cancelledChapters.length > 0) {
    message.info(`Đã hủy. ${doneChapters.length} chapter mới đã checkpoint (${uploadedImages} ảnh) — chạy lại hoặc bấm Thử lại trên từng dòng để tiếp tục.`)
    return
  }

  if (errorChapters.length > 0) {
    message.error(
      `Hoàn thành với lỗi. ${doneChapters.length} chapter mới (${uploadedImages} ảnh) đã upload thành công`
      + (skippedCount > 0 ? `, bỏ qua ${skippedCount} chapter đã có` : '')
      + `. ${errorChapters.length} chapter LỖI, bấm Thử lại trên từng dòng: `
      + errorChapters.map(c => `"${c.name}" (${c.error})`).join('; ')
    , 12)
    return
  }

  message.success(
    `Hoàn thành! ${doneChapters.length} chapter mới (${uploadedImages} ảnh) đã xáo & upload lên Drive.`
    + (skippedCount > 0 ? ` Bỏ qua ${skippedCount} chapter đã có.` : '')
  )
}
