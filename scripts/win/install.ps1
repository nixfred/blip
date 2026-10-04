# Install the Windows tray build for the current user.
# Re-running copies a new build over the old one and leaves the shortcut in place.
param(
    [switch] $PublishOnly,
    [switch] $NoStart
)

$ErrorActionPreference = "Stop"
$Repo = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$Dotnet = Join-Path $env:LOCALAPPDATA "Microsoft\dotnet\dotnet.exe"
if (-not (Test-Path $Dotnet)) { $Dotnet = "dotnet" }
$Bun = Join-Path $env:USERPROFILE ".bun\bin\bun.exe"
if (-not (Test-Path $Bun)) { throw "bun is not installed" }

$Rid = if ([System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture -eq "Arm64") { "win-arm64" } else { "win-x64" }
$ShimOut = Join-Path $Repo "windows\publish\shim"
$AppOut = Join-Path $Repo "windows\publish\app"

& $Dotnet publish (Join-Path $Repo "windows\BlipShim\BlipShim.csproj") -c Release -r $Rid --self-contained true -o $ShimOut
if ($LASTEXITCODE -ne 0) { throw "shim publish failed" }
& $Dotnet publish (Join-Path $Repo "windows\BlipTray\BlipTray.csproj") -c Release -r $Rid --self-contained true -o $AppOut
if ($LASTEXITCODE -ne 0) { throw "tray publish failed" }

$HostExe = Join-Path $ShimOut "BlipShim.exe"
foreach ($Name in @("imsg", "imsg-send", "imsg-read", "imsg-react", "contacts", "contact-save")) {
    Copy-Item $HostExe (Join-Path $ShimOut "$Name.exe") -Force
}
if ($PublishOnly) { return }

Get-Process -Name Blip -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Milliseconds 400

$Root = Join-Path $env:LOCALAPPDATA "Programs\Blip"
$ShimDir = Join-Path $Root "shim"
$AppDir = Join-Path $Root "app"
New-Item -ItemType Directory -Force $ShimDir, $AppDir | Out-Null
Copy-Item (Join-Path $ShimOut "*") $ShimDir -Force
Copy-Item (Join-Path $AppOut "*") $AppDir -Force

$Fixture = Join-Path $Repo "scripts\demo\fake-imsg"
Set-Content -Path (Join-Path $ShimDir "fixture.script") -Value $Fixture -Encoding ascii

$BinDir = ($ShimDir -replace "\\", "/")
$ConfDir = Join-Path $env:USERPROFILE ".config\blip"
$Conf = Join-Path $ConfDir "bridge.conf"
New-Item -ItemType Directory -Force $ConfDir | Out-Null
if (-not (Test-Path $Conf)) {
    @(
        "host=fixture"
        "push_read=off"
        "bin_dir=$BinDir"
    ) | Set-Content -Path $Conf -Encoding ascii
} else {
    $Text = Get-Content -Path $Conf -Raw
    if ($Text -notmatch "(?m)^host=") { Add-Content -Path $Conf -Value "host=fixture" }
    if ($Text -notmatch "(?m)^push_read=" -and ($Text -match "(?m)^host=fixture" -or $Text -notmatch "(?m)^host=")) {
        Add-Content -Path $Conf -Value "push_read=off"
    }
    if ($Text -notmatch "(?m)^bin_dir=") { Add-Content -Path $Conf -Value "bin_dir=$BinDir" }
}

@{ repo = $Repo; bun = $Bun } | ConvertTo-Json | Set-Content -Path (Join-Path $AppDir "launch.json") -Encoding utf8
$Exe = Join-Path $AppDir "Blip.exe"
$Start = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\Blip.lnk"
$Wsh = New-Object -ComObject WScript.Shell
$Lnk = $Wsh.CreateShortcut($Start)
$Lnk.TargetPath = $Exe
$Lnk.WorkingDirectory = $AppDir
$Lnk.IconLocation = "$Exe,0"
$Lnk.Description = "Blip"
$Lnk.Save()
New-Item -Path "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run" -Force | Out-Null
Set-ItemProperty -Path "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run" -Name "Blip" -Value "`"$Exe`""
if (-not $NoStart) { Start-Process $Exe }
Write-Output "installed $Exe"
