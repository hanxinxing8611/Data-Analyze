# PowerShell side of the node_modules "decrypt" pipeline.
# Runs `node tools/decrypt-nm.mjs`, reads NDJSON lines from its stdout,
# decodes base64 payloads and rewrites each file as plaintext.
# Written by PowerShell = not encrypted by the filter driver.
param([string]$Target = 'node_modules')

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = 'node'
$psi.Arguments = "tools/decrypt-nm.mjs $Target"
$psi.WorkingDirectory = $root
$psi.RedirectStandardOutput = $true
$psi.RedirectStandardError = $true
$psi.UseShellExecute = $false
$psi.StandardOutputEncoding = [System.Text.Encoding]::UTF8

$proc = [System.Diagnostics.Process]::Start($psi)

$reader = New-Object System.IO.StreamReader($proc.StandardOutput.BaseStream, [System.Text.Encoding]::UTF8)
$count = 0
while ($null -ne ($line = $reader.ReadLine())) {
  if ([string]::IsNullOrWhiteSpace($line)) { continue }
  try {
    $obj = $line | ConvertFrom-Json
    $bytes = [Convert]::FromBase64String($obj.d)
    $full = Join-Path $root $obj.p
    [System.IO.File]::WriteAllBytes($full, $bytes)
    $count++
    if ($count % 2000 -eq 0) { Write-Host "  rewritten: $count files..." }
  } catch {
    Write-Host "FAIL line: $($line.Substring(0, [Math]::Min(120, $line.Length)))"
  }
}

$proc.WaitForExit()
$errText = $proc.StandardError.ReadToEnd()
if ($errText) { Write-Host $errText }
Write-Host "DECRYPT DONE: $count files rewritten as plaintext"
