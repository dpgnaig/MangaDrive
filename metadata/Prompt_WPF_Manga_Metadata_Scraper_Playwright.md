# Prompt: WPF Manga Metadata Scraper bằng Playwright

## Vai trò

Bạn là Senior Software Architect và Senior .NET Developer.

Hãy xây dựng một project hoàn chỉnh theo Clean Architecture, SOLID và dễ
mở rộng.

------------------------------------------------------------------------

# Mục tiêu

Xây dựng một tool Desktop bằng **WPF (.NET 8)** sử dụng **Microsoft
Playwright** để scrape metadata manga từ nhiều website.

Website hiện tại:

1.  https://cuutruyen.net/
2.  https://truyenqqko.com/

Trong tương lai có thể thêm nhiều website khác mà không phải sửa logic
chính.

------------------------------------------------------------------------

# Luồng hoạt động

Người dùng nhập:

-   Manga Name

Sau đó hệ thống thực hiện:

    Search(keyword)

    ↓

    CuuTruyenScraper

    ↓

    Có metadata?
        YES → return

        NO

    ↓

    TruyenQQScraper

    ↓

    Có metadata?
        YES → return

        NO

    ↓

    return null

------------------------------------------------------------------------

# Yêu cầu kỹ thuật

-   .NET 8
-   WPF
-   MVVM
-   Microsoft.Playwright
-   Dependency Injection
-   async/await
-   ILogger
-   CancellationToken
-   SOLID
-   Clean Architecture

------------------------------------------------------------------------

# Cấu trúc project

    MangaMetadataScraper

    ├── App
    │   ├── ViewModels
    │   ├── Views
    │   └── Commands
    │
    ├── Core
    │   ├── Models
    │   ├── Interfaces
    │   └── Services
    │
    ├── Infrastructure
    │   ├── Browser
    │   ├── Scrapers
    │   │     ├── CuuTruyenScraper
    │   │     └── TruyenQQScraper
    │   └── Logging
    │
    └── Program

------------------------------------------------------------------------

# Model

Tạo model:

-   Title
-   AlternativeTitle
-   Description
-   Author
-   Artist
-   Genres
-   Status
-   CoverUrl
-   Source
-   DetailUrl

------------------------------------------------------------------------

# Interface

``` csharp
public interface IMangaScraper
{
    Task<MangaMetadata?> SearchAsync(
        string keyword,
        CancellationToken cancellationToken = default);
}
```

------------------------------------------------------------------------

# Browser Factory

Chỉ mở **một Chromium Browser**.

Các scraper chỉ tạo Context/Page.

Không launch browser nhiều lần.

------------------------------------------------------------------------

# Fallback Service

    foreach scraper

    ↓

    try Search()

    ↓

    if result != null

    return result

    ↓

    next scraper

    ↓

    return null

Không được throw exception nếu website lỗi.

Chỉ log lỗi.

------------------------------------------------------------------------

# Playwright

-   Reuse Browser
-   New Context cho mỗi request
-   Timeout
-   Retry
-   WaitUntil NetworkIdle
-   Dispose đúng cách

------------------------------------------------------------------------

# CuuTruyen

Ưu tiên sử dụng API nếu có.

Nếu API thay đổi thì fallback sang HTML.

Metadata cần lấy:

-   title
-   cover
-   description
-   author
-   genres
-   status

------------------------------------------------------------------------

# TruyenQQ

Search theo keyword.

Lấy manga đầu tiên.

Đi vào trang detail.

Lấy metadata tương tự.

------------------------------------------------------------------------

# Logging

Log:

-   Search bắt đầu
-   Website đang search
-   URL
-   Thời gian
-   Thành công
-   Không tìm thấy
-   Exception

------------------------------------------------------------------------

# UI

Có:

Textbox Keyword

Button Search

ProgressBar

Status

Cover Preview

Metadata

Source

------------------------------------------------------------------------

# Kết quả

Nếu tìm được:

Hiển thị toàn bộ metadata.

Nếu không:

Hiển thị:

    No metadata found.

------------------------------------------------------------------------

# Khả năng mở rộng

Muốn thêm website mới chỉ cần:

-   tạo class mới implement IMangaScraper
-   đăng ký DI

Không sửa SearchService.

Ví dụ:

    MangaDexScraper

    MangaFoxScraper

    NetTruyenScraper

------------------------------------------------------------------------

# Yêu cầu code

Sinh đầy đủ:

-   Folder
-   Project
-   Model
-   Interface
-   BrowserFactory
-   SearchService
-   ViewModel
-   ICommand
-   DI
-   Playwright code
-   Retry
-   Logging
-   Exception handling

Code phải production-ready, dễ bảo trì và dễ mở rộng.
