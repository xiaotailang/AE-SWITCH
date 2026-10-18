$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'workspace-env.ps1')
Add-Type -AssemblyName System.Drawing
$taskIconDirectory = Join-Path $env:AE_WORKSPACE 'app/src-tauri/icons'
New-Item -ItemType Directory -Path $taskIconDirectory -Force | Out-Null
$taskBitmap = [Drawing.Bitmap]::new(256, 256)
$taskGraphics = [Drawing.Graphics]::FromImage($taskBitmap)
$taskGraphics.SmoothingMode = [Drawing.Drawing2D.SmoothingMode]::AntiAlias
$taskGraphics.Clear([Drawing.ColorTranslator]::FromHtml('#151c29'))
$taskPen = [Drawing.Pen]::new([Drawing.ColorTranslator]::FromHtml('#abc3f4'), 9)
$taskPen.LineJoin = [Drawing.Drawing2D.LineJoin]::Round
foreach ($taskLayer in @(0, 32, 64)) {
    $taskPoints = [Drawing.PointF[]]@([Drawing.PointF]::new(54, 82 + $taskLayer), [Drawing.PointF]::new(128, 44 + $taskLayer), [Drawing.PointF]::new(202, 82 + $taskLayer), [Drawing.PointF]::new(128, 120 + $taskLayer))
    if ($taskLayer -eq 0) { $taskGraphics.DrawPolygon($taskPen, $taskPoints) }
    else { $taskGraphics.DrawLines($taskPen, [Drawing.PointF[]]@($taskPoints[0], $taskPoints[3], $taskPoints[2])) }
}
$taskPng = Join-Path $taskIconDirectory 'icon.png'
$taskBitmap.Save($taskPng, [Drawing.Imaging.ImageFormat]::Png)
$taskPen.Dispose()
$taskGraphics.Dispose()
$taskBitmap.Dispose()
$taskPngBytes = [IO.File]::ReadAllBytes($taskPng)
$taskWriter = [IO.BinaryWriter]::new([IO.File]::Create((Join-Path $taskIconDirectory 'icon.ico')))
try {
    $taskWriter.Write([uint16]0); $taskWriter.Write([uint16]1); $taskWriter.Write([uint16]1)
    $taskWriter.Write([byte]0); $taskWriter.Write([byte]0); $taskWriter.Write([byte]0); $taskWriter.Write([byte]0)
    $taskWriter.Write([uint16]1); $taskWriter.Write([uint16]32)
    $taskWriter.Write([uint32]$taskPngBytes.Length); $taskWriter.Write([uint32]22)
    $taskWriter.Write($taskPngBytes)
} finally { $taskWriter.Dispose() }
Write-Output 'AE Switch application icons generated.'
