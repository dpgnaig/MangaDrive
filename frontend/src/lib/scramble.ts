// Core scramble/unscramble permutation logic.
// Single source of truth shared by the reader (UnscrambleImage) and the admin
// scramble tool (AdminScrambleTab), so both produce/consume the exact same
// permutation. Mirrors the C# tool (scramble/MangaScramble/ScrambleAlgorithm.cs)
// — FNV-1a seed + Mulberry32 PRNG + Fisher-Yates — for cross-platform parity.

export function getSeedFromKey(key: string): number {
  let hash = 2166136261 >>> 0
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i)
    hash = Math.imul(hash, 16777619) >>> 0
  }
  return hash >>> 0
}

export function mulberry32Next(state: number): [number, number] {
  state = (state + 0x6D2B79F5) >>> 0
  let t = state >>> 0
  t = Math.imul(t ^ (t >>> 15), t | 1) >>> 0
  const inner = Math.imul(t ^ (t >>> 7), t | 61) >>> 0
  t = (t ^ ((t + inner) >>> 0)) >>> 0
  const result = (t ^ (t >>> 14)) >>> 0
  return [result, state]
}

export function generatePermutation(key: string, grid: number): number[] {
  const totalTiles = grid * grid
  const indices = Array.from({ length: totalTiles }, (_, i) => i)
  let seed = getSeedFromKey(key)
  for (let i = totalTiles - 1; i > 0; i--) {
    const [rnd, newSeed] = mulberry32Next(seed)
    seed = newSeed
    const j = rnd % (i + 1)
    ;[indices[i], indices[j]] = [indices[j], indices[i]]
  }
  return indices
}

export function generateInversePermutation(key: string, grid: number): number[] {
  const perm = generatePermutation(key, grid)
  const inverse = new Array(perm.length)
  for (let i = 0; i < perm.length; i++) {
    inverse[perm[i]] = i
  }
  return inverse
}
