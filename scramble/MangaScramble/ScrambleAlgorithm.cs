namespace MangaScramble;

/// <summary>
/// Core scramble/unscramble algorithm.
/// Uses a seeded shuffle based on the key string to deterministically
/// rearrange grid tiles. Same key + grid = same permutation.
/// 
/// IMPORTANT: Uses custom Mulberry32 PRNG for cross-platform consistency
/// (same results in C# and JavaScript).
/// </summary>
public static class ScrambleAlgorithm
{
    /// <summary>
    /// Generate the tile permutation for a given key and grid size.
    /// Returns an array where result[i] = source tile index for destination tile i.
    /// </summary>
    public static int[] GeneratePermutation(string key, int grid)
    {
        int totalTiles = grid * grid;
        var indices = Enumerable.Range(0, totalTiles).ToArray();

        // Use a deterministic seed from the key
        uint seed = GetSeedFromKey(key);

        // Fisher-Yates shuffle using Mulberry32 PRNG
        for (int i = totalTiles - 1; i > 0; i--)
        {
            uint rnd = Mulberry32Next(ref seed);
            int j = (int)(rnd % (uint)(i + 1));
            (indices[i], indices[j]) = (indices[j], indices[i]);
        }

        return indices;
    }

    /// <summary>
    /// Generate the inverse permutation (for unscrambling).
    /// </summary>
    public static int[] GenerateInversePermutation(string key, int grid)
    {
        var perm = GeneratePermutation(key, grid);
        var inverse = new int[perm.Length];
        for (int i = 0; i < perm.Length; i++)
        {
            inverse[perm[i]] = i;
        }
        return inverse;
    }

    /// <summary>
    /// Convert a key string to a deterministic uint seed using FNV-1a hash.
    /// </summary>
    public static uint GetSeedFromKey(string key)
    {
        uint hash = 2166136261;
        foreach (char c in key)
        {
            hash ^= c;
            hash *= 16777619;
        }
        return hash;
    }

    /// <summary>
    /// Mulberry32 PRNG - simple, fast, deterministic, cross-platform.
    /// Returns next pseudo-random uint and advances state.
    /// </summary>
    private static uint Mulberry32Next(ref uint state)
    {
        state += 0x6D2B79F5;
        uint t = state;
        t = (t ^ (t >> 15)) * (t | 1);
        t ^= t + (t ^ (t >> 7)) * (t | 61);
        return t ^ (t >> 14);
    }
}
