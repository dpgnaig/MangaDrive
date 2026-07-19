# Build stage
FROM mcr.microsoft.com/dotnet/sdk:8.0 AS build
WORKDIR /src

COPY MangaDrive.sln .
COPY MangaDrive.Api/MangaDrive.Api.csproj MangaDrive.Api/
COPY MangaDrive.Core/MangaDrive.Core.csproj MangaDrive.Core/
COPY MangaDrive.Infrastructure/MangaDrive.Infrastructure.csproj MangaDrive.Infrastructure/
RUN dotnet restore

COPY . .
RUN dotnet publish MangaDrive.Api/MangaDrive.Api.csproj -c Release -o /app/publish

# Runtime stage
FROM mcr.microsoft.com/dotnet/aspnet:8.0 AS runtime
WORKDIR /app

COPY --from=build /app/publish .

# SQLite database will be stored in /app/data
RUN mkdir -p /app/data

ENV ASPNETCORE_URLS=http://+:5000
ENV ConnectionStrings__DefaultConnection="Data Source=/app/data/mangadrive.db"

EXPOSE 5000

ENTRYPOINT ["dotnet", "MangaDrive.Api.dll"]
