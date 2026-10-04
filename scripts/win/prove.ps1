# Prove the tray against the invented demo. A real host= is refused.
$ErrorActionPreference = "Stop"
$Repo = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
& (Join-Path $PSScriptRoot "install.ps1") -PublishOnly

$Shim = Join-Path $Repo "windows\publish\shim"
$App = Join-Path $Repo "windows\publish\app\Blip.exe"
$Bun = Join-Path $env:USERPROFILE ".bun\bin\bun.exe"
$Fixture = Join-Path $Repo "scripts\demo\fake-imsg"
if ((Split-Path -Leaf $Fixture) -ne "fake-imsg") { throw "fixture script name drifted" }

$Sandbox = Join-Path $env:TEMP ("blip-prove-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force (Join-Path $Sandbox ".config\blip") | Out-Null
$Bin = ($Shim -replace "\\", "/")
@(
    "host=fixture"
    "push_read=off"
    "bin_dir=$Bin"
) | Set-Content -Path (Join-Path $Sandbox ".config\blip\bridge.conf") -Encoding ascii

$env:HOME = $Sandbox
$env:BLIP_FIXTURE_SCRIPT = $Fixture
$env:BLIP_REPO = $Repo
$env:BLIP_BUN = $Bun
$env:BLIP_BRIDGE_CONF = Join-Path $Sandbox ".config\blip\bridge.conf"

$Sentinel = "BLIP-SENTINEL-" + [guid]::NewGuid().ToString("N")
$Stdin = Join-Path $env:TEMP ("blip-stdin-" + [guid]::NewGuid().ToString("N"))
Set-Content -Path $Stdin -Value $Sentinel -Encoding ascii -NoNewline
$Send = Start-Process -FilePath (Join-Path $Shim "imsg-send.exe") -ArgumentList @("--to", "+15551234567", "--yes", "--text-stdin", "--keep-dashes") -Wait -PassThru -NoNewWindow -RedirectStandardInput $Stdin
Remove-Item $Stdin -Force
if ($Send.ExitCode -ne 0) { throw "fixture send exited $($Send.ExitCode)" }

$Hits = Get-ChildItem -Path $Sandbox -Recurse -File -ErrorAction SilentlyContinue | Where-Object {
    (Get-Content -Path $_.FullName -Raw -ErrorAction SilentlyContinue) -like "*$Sentinel*"
}
if ($Hits) { throw "send body was written under the sandbox" }

$ChatText = (& (Join-Path $Shim "imsg.exe") --json chats 20 | Out-String)
if ($LASTEXITCODE -ne 0 -or $ChatText -notmatch "Jamie Rivera") { throw "fixture chats did not list the demo person" }

$Proof = Join-Path $Sandbox "proof"
$Tray = Start-Process -FilePath $App -ArgumentList @("--proof", $Proof) -Wait -PassThru
if ($Tray.ExitCode -ne 0) { throw "tray proof exited $($Tray.ExitCode)" }
$Png = Join-Path $Proof "window.png"
$Doc = Get-Content (Join-Path $Proof "proof.json") -Raw | ConvertFrom-Json
if (-not (Test-Path $Png)) { throw "window screenshot missing" }
if ((Get-Item $Png).Length -lt 10000) { throw "window screenshot is empty" }
if (-not $Doc.tray) { throw "tray icon was not created" }
if ($Doc.names -notcontains "Jamie Rivera") { throw "window did not list the demo person" }
if ($Doc.bubbles -lt 1) { throw "thread did not render" }
if ($Doc.readOnOpen) { throw "opening the list marked the thread read" }
if (-not $Doc.readOnCompose) { throw "compose focus did not mark the thread read" }
if (-not $Doc.markAll) { throw "mark all did not run" }

$State = Join-Path $Sandbox ".local\state\blip\state.json"
$Window = Join-Path $Sandbox ".local\state\blip\window.json"
foreach ($File in @($State, $Window, (Join-Path $Proof "proof.json"))) {
    if (-not (Test-Path $File)) { continue }
    $Raw = Get-Content -Path $File -Raw
    if ($Raw -like "*trailhead at 7*") { throw "message text landed in $File" }
    if ($Raw -like "*sounds good, see you then*") { throw "message text landed in $File" }
    if ($Raw -like "*$Sentinel*") { throw "send body landed in $File" }
}
Write-Output "prove ok $Proof"
