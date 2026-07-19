using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace MangaDrive.Infrastructure.Migrations
{
    /// <inheritdoc />
    public partial class AddViewCountToManga : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<int>(
                name: "ViewCount",
                table: "Mangas",
                type: "INTEGER",
                nullable: false,
                defaultValue: 0);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "ViewCount",
                table: "Mangas");
        }
    }
}
