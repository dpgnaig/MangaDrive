export function imgUrl(fileId: string): string {
  // External metadata sources (AniList/MangaDex) store absolute image URLs;
  // serve those directly. Drive file IDs go through the image proxy.
  if (/^https?:\/\//i.test(fileId)) return fileId
  return `/api/images/${fileId}`
}
