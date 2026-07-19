// Shared types for the admin source-management views (tab + desktop table).

export interface RootFolder { id: string; name: string; googleDriveFolderId: string; isPublic: boolean; isActive: boolean; isAutoAdded: boolean }
export interface MangaChild { id: string; title: string; isHidden: boolean; linkedMangaId: string | null }

export interface SyncProgress {
  syncJobId: string; rootFolderId: string; rootName: string; status: string
  currentManga: string; currentChapter: string
  totalManga: number; syncedManga: number
  totalChapter: number; syncedChapter: number
  totalImage: number; syncedImage: number
  currentMangaTotalChapter: number; currentMangaSyncedChapter: number
  currentMangaNewChapters: number
  percent: number; message: string
}

export interface ScannedFolder { driveFileId: string; name: string; synced: boolean; mangaId: string | null; mangaTitle: string | null; lastSynced: string | null }
export interface OrphanManga { id: string; title: string; driveFileId: string }
export interface ScanResult { total: number; synced: number; notSynced: number; orphanCount: number; folders: ScannedFolder[]; orphans: OrphanManga[] }
