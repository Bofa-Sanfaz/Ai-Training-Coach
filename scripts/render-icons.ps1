# Renders launcher PNGs from the SVG sources.
# Headless Microsoft Edge rasterises each SVG once at 1024 px, then
# System.Drawing downsamples (bicubic) to every Android density.
# Run from the repo root:  powershell -ExecutionPolicy Bypass -File scripts\render-icons.ps1
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$root = Split-Path -Parent $PSScriptRoot
$edge = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
if (-not (Test-Path $edge)) { throw "Microsoft Edge not found at $edge" }

$tmp = Join-Path $env:TEMP 'rp-icon-render'
New-Item -ItemType Directory -Force $tmp | Out-Null

function Rasterize($svg, $out) {
  if (Test-Path $out) { Remove-Item $out }
  $uri = ([System.Uri](Resolve-Path $svg).Path).AbsoluteUri
  $args = @('--headless=new', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1',
    '--default-background-color=00000000', "--user-data-dir=`"$tmp`"",
    '--window-size=1024,1024', "--screenshot=`"$out`"", $uri)
  Start-Process -FilePath $edge -ArgumentList $args -Wait -WindowStyle Hidden -RedirectStandardError (Join-Path $tmp 'err.txt')
  if (-not (Test-Path $out)) { throw "Render failed: $svg" }
}

function Resize($src, $out, $size) {
  New-Item -ItemType Directory -Force (Split-Path $out) | Out-Null
  $img = [System.Drawing.Image]::FromFile($src)
  $bmp = New-Object System.Drawing.Bitmap $size, $size, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
  $g.Clear([System.Drawing.Color]::Transparent)
  $g.DrawImage($img, 0, 0, $size, $size)
  $bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose(); $img.Dispose()
  Write-Output ("{0,-58} {1}px" -f $out.Replace($root, '.'), $size)
}

$sq = Join-Path $tmp 'square.png'; Rasterize (Join-Path $root 'www\img\logo.svg') $sq
$rd = Join-Path $tmp 'round.png';  Rasterize (Join-Path $root 'assets\logo-round.svg') $rd
$sp = Join-Path $tmp 'splash.png'; Rasterize (Join-Path $root 'assets\splash-logo.svg') $sp

$res = Join-Path $root 'android-res'
$densities = [ordered]@{ 'mdpi' = 48; 'hdpi' = 72; 'xhdpi' = 96; 'xxhdpi' = 144; 'xxxhdpi' = 192 }
foreach ($d in $densities.Keys) {
  Resize $sq "$res\mipmap-$d\ic_launcher.png" $densities[$d]
  Resize $rd "$res\mipmap-$d\ic_launcher_round.png" $densities[$d]
}
Resize $sp "$res\drawable-nodpi\splash_logo.png" 360
Resize $sq (Join-Path $root 'assets\logo-512.png') 512
Copy-Item $sq (Join-Path $root 'assets\logo-1024.png') -Force
Write-Output 'assets\logo-1024.png 1024px'
