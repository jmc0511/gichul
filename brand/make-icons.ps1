param([string]$Src, [string]$Out, [string]$LensSrc)
Add-Type -AssemblyName System.Drawing
$img = [System.Drawing.Image]::FromFile($Src)

function Save-Png($srcRect, [int]$size, [string]$path, [int]$pad = 0) { $im = $img; if ($srcRect -eq $null) { $im = $lensImg; $srcRect = New-Object System.Drawing.Rectangle 0, 0, $lensImg.Width, $lensImg.Height }
  $bmp = New-Object System.Drawing.Bitmap $size, $size
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.Clear([System.Drawing.Color]::White)
  $dst = New-Object System.Drawing.Rectangle $pad, $pad, ($size - 2 * $pad), ($size - 2 * $pad)
  $g.DrawImage($im, $dst, $srcRect, [System.Drawing.GraphicsUnit]::Pixel)
  $g.Dispose()
  $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
}

$full = New-Object System.Drawing.Rectangle 0, 0, $img.Width, $img.Height
$lensImg = [System.Drawing.Image]::FromFile($LensSrc); $lens = $null

Save-Png $lens 16 "$Out\favicon-16.png"
Save-Png $lens 32 "$Out\favicon-32.png"
Save-Png $lens 48 "$Out\favicon-48.png"
Save-Png $full 180 "$Out\apple-touch-icon.png" 8
Save-Png $full 192 "$Out\icon-192.png"
Save-Png $full 512 "$Out\icon-512.png"
Save-Png $full 512 "$Out\icon-maskable-512.png" 56

$sizes = 16, 32, 48
$pngs = $sizes | ForEach-Object { , [System.IO.File]::ReadAllBytes("$Out\favicon-$_.png") }
$ms = New-Object System.IO.MemoryStream
$w = New-Object System.IO.BinaryWriter $ms
$w.Write([UInt16]0); $w.Write([UInt16]1); $w.Write([UInt16]$sizes.Count)
$offset = 6 + 16 * $sizes.Count
for ($i = 0; $i -lt $sizes.Count; $i++) {
  $s = $sizes[$i]; $len = $pngs[$i].Length
  $w.Write([byte]$s); $w.Write([byte]$s); $w.Write([byte]0); $w.Write([byte]0)
  $w.Write([UInt16]1); $w.Write([UInt16]32); $w.Write([UInt32]$len); $w.Write([UInt32]$offset)
  $offset += $len
}
foreach ($p in $pngs) { $w.Write($p) }
$w.Flush()
[System.IO.File]::WriteAllBytes("$Out\favicon.ico", $ms.ToArray())
$w.Dispose()
Remove-Item "$Out\favicon-48.png"
$img.Dispose()



