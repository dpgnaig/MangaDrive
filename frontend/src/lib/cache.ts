import api from './api'

let mangaCache: any[] | null = null
let cacheTime = 0
const CACHE_TTL = 5 * 60 * 1000 // 5 minutes

export async function getMangas(forceRefresh = false) {
  const now = Date.now()
  if (mangaCache && !forceRefresh && (now - cacheTime) < CACHE_TTL) return mangaCache
  const { data } = await api.get('/mangas')
  mangaCache = data
  cacheTime = now
  return data
}

export function invalidateMangaCache() { mangaCache = null; cacheTime = 0 }
