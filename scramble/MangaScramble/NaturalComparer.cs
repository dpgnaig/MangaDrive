using System.Globalization;

namespace MangaScramble;

/// <summary>
/// Natural (numeric-aware) string comparer so file/folder ordering matches the web
/// tool's localeCompare(a, b, { numeric: true }). Splits each string into runs of
/// digits and non-digits; digit runs compare by numeric value ("2" &lt; "10"),
/// everything else compares case-insensitively. This keeps 001.png..010.png and
/// "Chap 2" before "Chap 10" identical on both tools.
/// </summary>
public sealed class NaturalComparer : IComparer<string>
{
    public static readonly NaturalComparer Instance = new();

    public int Compare(string? x, string? y)
    {
        if (x == null) return y == null ? 0 : -1;
        if (y == null) return 1;

        int i = 0, j = 0;
        while (i < x.Length && j < y.Length)
        {
            bool xDigit = char.IsDigit(x[i]);
            bool yDigit = char.IsDigit(y[j]);

            if (xDigit && yDigit)
            {
                int xStart = i, yStart = j;
                while (i < x.Length && char.IsDigit(x[i])) i++;
                while (j < y.Length && char.IsDigit(y[j])) j++;

                // Compare digit runs by value; strip leading zeros to avoid overflow.
                var xNum = x.Substring(xStart, i - xStart).TrimStart('0');
                var yNum = y.Substring(yStart, j - yStart).TrimStart('0');
                if (xNum.Length != yNum.Length) return xNum.Length - yNum.Length;
                int numCmp = string.CompareOrdinal(xNum, yNum);
                if (numCmp != 0) return numCmp;
                // Equal value: shorter original (more leading zeros) sorts first.
                int lenCmp = (i - xStart) - (j - yStart);
                if (lenCmp != 0) return lenCmp;
            }
            else
            {
                int cmp = string.Compare(
                    x[i].ToString(), y[j].ToString(),
                    CultureInfo.CurrentCulture, CompareOptions.IgnoreCase);
                if (cmp != 0) return cmp;
                i++;
                j++;
            }
        }

        return (x.Length - i) - (y.Length - j);
    }
}
