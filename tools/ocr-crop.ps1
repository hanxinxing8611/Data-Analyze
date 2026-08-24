param(
  [string]$ImagePath,
  [double]$Y0 = 0.60,
  [double]$Y1 = 0.92,
  [double]$Scale = 2.0
)

Add-Type -AssemblyName System.Drawing

$bmp = [System.Drawing.Bitmap]::FromFile($ImagePath)
$w = $bmp.Width
$h = $bmp.Height
Write-Host ("Image size: " + $w + "x" + $h)

$cy0 = [int]([math]::Floor($h * $Y0))
$cy1 = [int]([math]::Floor($h * $Y1))
$ch = $cy1 - $cy0

$crop = New-Object System.Drawing.Bitmap($w, $ch)
$g = [System.Drawing.Graphics]::FromImage($crop)
$dstRect = New-Object System.Drawing.Rectangle(0, 0, $w, $ch)
$srcRect = New-Object System.Drawing.Rectangle(0, $cy0, $w, $ch)
$g.DrawImage($bmp, $dstRect, $srcRect, [System.Drawing.GraphicsUnit]::Pixel)
$g.Dispose()

$scaled = New-Object System.Drawing.Bitmap([int]($w * $Scale), [int]($ch * $Scale))
$g2 = [System.Drawing.Graphics]::FromImage($scaled)
$g2.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g2.DrawImage($crop, 0, 0, $scaled.Width, $scaled.Height)
$g2.Dispose()

$temp = Join-Path $env:TEMP ("ocr_crop_" + [guid]::NewGuid().ToString('N') + ".png")
$scaled.Save($temp, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
$crop.Dispose()
$scaled.Dispose()

Write-Host ("Temp file: " + $temp)
& powershell -ExecutionPolicy Bypass -File "$PSScriptRoot\ocr-image.ps1" -ImagePath $temp
$exit = $LASTEXITCODE
Remove-Item $temp -ErrorAction SilentlyContinue
exit $exit
