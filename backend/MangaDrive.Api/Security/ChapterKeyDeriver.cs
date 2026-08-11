using System.Security.Cryptography;
using System.Text;

namespace MangaDrive.Api.Security;

public static class ChapterKeyDeriver
{
    public static string Derive(string masterKey, string slug)
    {
        using var hmac = new HMACSHA256(Encoding.UTF8.GetBytes(masterKey));
        var signature = hmac.ComputeHash(Encoding.UTF8.GetBytes(slug));
        return Convert.ToHexString(signature).ToLowerInvariant();
    }
}
