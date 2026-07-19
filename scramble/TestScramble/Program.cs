var key = "126f08b45659f7d65e91dbcb2e680a9908fb54ce";
var grid = 6;

// FNV-1a hash (returns uint)
uint hash = 2166136261;
foreach (char c in key)
{
    hash ^= c;
    hash *= 16777619;
}
uint seed = hash;
Console.WriteLine($"Key: {key}");
Console.WriteLine($"Grid: {grid}");
Console.WriteLine($"Seed (uint): {seed}");

// Generate permutation with Mulberry32
int totalTiles = grid * grid;
var indices = Enumerable.Range(0, totalTiles).ToArray();

for (int i = totalTiles - 1; i > 0; i--)
{
    uint rnd = Mulberry32Next(ref seed);
    int j = (int)(rnd % (uint)(i + 1));
    Console.WriteLine($"  i={i}, rnd={rnd}, j={j}");
    (indices[i], indices[j]) = (indices[j], indices[i]);
}

Console.WriteLine($"Permutation: [{string.Join(", ", indices)}]");

var inverse = new int[totalTiles];
for (int i = 0; i < totalTiles; i++)
    inverse[indices[i]] = i;
Console.WriteLine($"Inverse: [{string.Join(", ", inverse)}]");

static uint Mulberry32Next(ref uint state)
{
    state += 0x6D2B79F5;
    uint t = state;
    t = (t ^ (t >> 15)) * (t | 1);
    t ^= t + (t ^ (t >> 7)) * (t | 61);
    return t ^ (t >> 14);
}
