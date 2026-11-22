$ErrorActionPreference = "Stop"

$RepoUrl = "https://github.com/jacky778199/Herdr_personalize.git"
$ZipUrl  = "https://github.com/jacky778199/Herdr_personalize/archive/refs/heads/main.zip"
$HerdrHome = if ($env:HERDR_APP_HOME) { $env:HERDR_APP_HOME } else { Join-Path $env:USERPROFILE ".config\herdr-app" }
$TmpDir = Join-Path $env:TEMP ("herdr-personalize-" + [System.Guid]::NewGuid().ToString("N").Substring(0, 8))

function Find-HerdrExe {
  # 1. PATH
  $cmd = Get-Command "herdr-app" -ErrorAction SilentlyContinue
  if ($cmd -and $cmd.Source -and (Test-Path $cmd.Source)) {
    return $cmd.Source
  }

  # 2. Common install locations
  $candidates = @(
    (Join-Path $env:LOCALAPPDATA "Programs\herdr-app\herdr-app.exe"),
    (Join-Path $env:LOCALAPPDATA "herdr-app\herdr-app.exe"),
    (Join-Path $env:ProgramFiles "herdr-app\herdr-app.exe"),
    (Join-Path $env:ProgramFiles "Herdr\herdr-app.exe"),
    (Join-Path ${env:ProgramFiles(x86)} "herdr-app\herdr-app.exe"),
    (Join-Path $env:USERPROFILE "scoop\apps\herdr-app\current\herdr-app.exe"),
    (Join-Path $env:USERPROFILE ".cargo\bin\herdr-app.exe")
  ) | Where-Object { $_ -and (Test-Path $_) }
  if ($candidates) {
    return ($candidates | Select-Object -First 1)
  }

  # 3. Windows Registry (App Paths & Uninstall entries)
  $regPaths = @(
    "HKCU:\Software\Microsoft\Windows\CurrentVersion\App Paths\herdr-app.exe",
    "HKLM:\Software\Microsoft\Windows\CurrentVersion\App Paths\herdr-app.exe",
    "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*",
    "HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*",
    "HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*"
  )
  foreach ($rp in $regPaths) {
    $items = Get-ItemProperty $rp -ErrorAction SilentlyContinue
    foreach ($it in $items) {
      if ($it.'(default)' -and (Test-Path $it.'(default)')) {
        return $it.'(default)'
      }
      if ($it.DisplayName -like "*herdr*" -or $it.DisplayIcon -like "*herdr-app*") {
        if ($it.InstallLocation) {
          $p = Join-Path $it.InstallLocation "herdr-app.exe"
          if (Test-Path $p) { return $p }
        }
        if ($it.DisplayIcon) {
          $iconPath = ($it.DisplayIcon -split ",")[0].Trim('"')
          if ($iconPath -like "*herdr-app.exe" -and (Test-Path $iconPath)) { return $iconPath }
        }
      }
    }
  }

  # 4. Start Menu / Desktop shortcuts
  $shortcutDirs = @(
    [Environment]::GetFolderPath("Programs"),
    [Environment]::GetFolderPath("CommonPrograms"),
    [Environment]::GetFolderPath("Desktop")
  ) | Where-Object { $_ -and (Test-Path $_) }
  if ($shortcutDirs) {
    $shell = New-Object -ComObject WScript.Shell
    foreach ($dir in $shortcutDirs) {
      $lnks = Get-ChildItem -Path $dir -Filter "*herdr*.lnk" -Recurse -ErrorAction SilentlyContinue
      foreach ($lnk in $lnks) {
        try {
          $target = $shell.CreateShortcut($lnk.FullName).TargetPath
          if ($target -and ($target -like "*herdr-app.exe") -and (Test-Path $target)) {
            return $target
          }
        } catch {}
      }
    }
  }

  return $null
}

Write-Host "==> Installing Herdr Personalize mods to: $HerdrHome" -ForegroundColor Cyan

try {
  $SourceDir = $null
  $LocalMods = if ($PSScriptRoot) { Join-Path $PSScriptRoot "mods" } else { $null }
  $LocalLayout = if ($PSScriptRoot) { Join-Path $PSScriptRoot "layouts\main-plus.json" } else { $null }

  if ($PSScriptRoot -and (Test-Path $LocalMods) -and (Test-Path $LocalLayout)) {
    Write-Host "    Using local repository: $PSScriptRoot" -ForegroundColor DarkGray
    $SourceDir = $PSScriptRoot
  } else {
    New-Item -ItemType Directory -Force -Path $TmpDir | Out-Null
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
  }

  if (-not (Test-Path $HerdrHome)) {
    New-Item -ItemType Directory -Force -Path $HerdrHome | Out-Null
  }

  # 1. Install layout and clear stale layout state cache
  $LayoutsSrc = Join-Path $SourceDir "layouts"
  $LayoutsDst = Join-Path $HerdrHome "layouts"
  if (Test-Path $LayoutsSrc) {
    New-Item -ItemType Directory -Force -Path $LayoutsDst | Out-Null
    Copy-Item -Path (Join-Path $LayoutsSrc "*") -Destination $LayoutsDst -Recurse -Force
    $StaleState = Join-Path $LayoutsDst ".state\main-plus.json"
    if (Test-Path $StaleState) {
      Remove-Item -Path $StaleState -Force -ErrorAction SilentlyContinue
      Write-Host "    [-] Removed stale layout state: .state\main-plus.json" -ForegroundColor Yellow
    }
    Write-Host "    [+] Installed layouts (main-plus.json)" -ForegroundColor Green
  }

  # 2. Clean legacy ai-team prototype and install custom mods
  $ModsSrc = Join-Path $SourceDir "mods"
  $ModsDst = Join-Path $HerdrHome "mods"
  $LegacyAiTeam = Join-Path $ModsDst "ai-team"
  if (Test-Path $LegacyAiTeam) {
    Remove-Item -Path $LegacyAiTeam -Recurse -Force -ErrorAction SilentlyContinue
    Write-Host "    [-] Removed legacy mod: ai-team" -ForegroundColor Yellow
  }
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

  # 3. Locate herdr-app.exe automatically and switch layout to main-plus
  $HerdrExe = Find-HerdrExe
  if ($HerdrExe) {
    Write-Host "    Found Herdr: $HerdrExe" -ForegroundColor DarkGray
    Write-Host "    Switching Herdr layout to main-plus ..."
    try {
      & $HerdrExe do layout.switch --name main-plus | Out-Null
      Write-Host "    [+] Active layout switched to main-plus" -ForegroundColor Green
    } catch {
      Write-Host "    [!] Herdr window not running; open Herdr and select layout 'main-plus'." -ForegroundColor Yellow
    }
  } else {
    Write-Host "    [!] herdr-app.exe not found on this machine. Please install Herdr Desktop first, then switch layout to 'main-plus'." -ForegroundColor Yellow
  }

  Write-Host "`nDone! Restart or focus Herdr to use all mods (including Cursor Usage panel)." -ForegroundColor Cyan
} finally {
  if (Test-Path $TmpDir) {
    Remove-Item -Path $TmpDir -Recurse -Force -ErrorAction SilentlyContinue
  }
}
