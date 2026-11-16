$ErrorActionPreference = "Stop"

$RepoUrl = "https://github.com/jacky778199/Herdr_personalize.git"
$ZipUrl  = "https://github.com/jacky778199/Herdr_personalize/archive/refs/heads/main.zip"
$HerdrHome = if ($env:HERDR_APP_HOME) { $env:HERDR_APP_HOME } else { Join-Path $env:USERPROFILE ".config\herdr-app" }
$TmpDir = Join-Path $env:TEMP ("herdr-personalize-" + [System.Guid]::NewGuid().ToString("N").Substring(0, 8))

Write-Host "==> Installing Herdr Personalize mods to: $HerdrHome" -ForegroundColor Cyan

try {
  New-Item -ItemType Directory -Force -Path $TmpDir | Out-Null
  $SourceDir = $null

  if (Get-Command git -ErrorAction SilentlyContinue) {
    Write-Host "    Cloning $RepoUrl ..."
    git clone --depth 1 $RepoUrl "$TmpDir\repo" | Out-Null
    $SourceDir = "$TmpDir\repo"
  } else {
    Write-Host "    Downloading $ZipUrl ..."
    $ZipPath = Join-Path $TmpDir "repo.zip"
    Invoke-WebRequest -Uri $ZipUrl -OutFile $ZipPath -UseBasicParsing
    Expand-Archive -Path $ZipPath -DestinationPath $TmpDir -Force
    $SourceDir = Join-Path $TmpDir "Herdr_personalize-main"
  }

  if (-not (Test-Path $HerdrHome)) {
    New-Item -ItemType Directory -Force -Path $HerdrHome | Out-Null
  }

  # 1. Install layout
  $LayoutsSrc = Join-Path $SourceDir "layouts"
  $LayoutsDst = Join-Path $HerdrHome "layouts"
  if (Test-Path $LayoutsSrc) {
    New-Item -ItemType Directory -Force -Path $LayoutsDst | Out-Null
    Copy-Item -Path (Join-Path $LayoutsSrc "*") -Destination $LayoutsDst -Recurse -Force
    Write-Host "    [+] Installed layouts (main-plus.json)" -ForegroundColor Green
  }

  # 2. Install custom mods
  $ModsSrc = Join-Path $SourceDir "mods"
  $ModsDst = Join-Path $HerdrHome "mods"
  if (Test-Path $ModsSrc) {
    New-Item -ItemType Directory -Force -Path $ModsDst | Out-Null
    Get-ChildItem -Path $ModsSrc -Directory | ForEach-Object {
      $modName = $_.Name
      $dstMod = Join-Path $ModsDst $modName
      New-Item -ItemType Directory -Force -Path $dstMod | Out-Null
      Copy-Item -Path (Join-Path $_.FullName "*") -Destination $dstMod -Recurse -Force
      Write-Host "    [+] Installed mod: $modName" -ForegroundColor Green
    }
  }

  # 3. Switch Herdr layout to main-plus if herdr-app CLI is available
  if (Get-Command herdr-app -ErrorAction SilentlyContinue) {
    Write-Host "    Switching Herdr layout to main-plus ..."
    try {
      herdr-app do layout.switch --name main-plus | Out-Null
      Write-Host "    [+] Active layout switched to main-plus" -ForegroundColor Green
    } catch {
      Write-Host "    [!] Herdr window not running; open Herdr and select layout 'main-plus'." -ForegroundColor Yellow
    }
  } else {
    Write-Host "    [!] herdr-app CLI not in PATH; open Herdr and switch layout to 'main-plus'." -ForegroundColor Yellow
  }

  Write-Host "`nDone! Restart or focus Herdr to use all mods (including Cursor Usage panel)." -ForegroundColor Cyan
} finally {
  if (Test-Path $TmpDir) {
    Remove-Item -Path $TmpDir -Recurse -Force -ErrorAction SilentlyContinue
  }
}
