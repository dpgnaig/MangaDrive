using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace MangaDrive.Infrastructure.Migrations
{
    /// <inheritdoc />
    public partial class AddChapterSlugAndGrid : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<int>(
                name: "Grid",
                table: "Chapters",
                type: "INTEGER",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "Slug",
                table: "Chapters",
                type: "TEXT",
                nullable: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "Grid",
                table: "Chapters");

            migrationBuilder.DropColumn(
                name: "Slug",
                table: "Chapters");
        }
    }
}
