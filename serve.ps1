Add-Type -AssemblyName System.Net.Http
$root = 'd:\Code\FrameFilm-main\tools\ForFilm'
$port = 8765
$prefix = "http://127.0.0.1:$port/"

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add($prefix)
$listener.Start()
Write-Host "Server running at $prefix"
Write-Host "Serving directory: $root"

$mime = @{
    '.html' = 'text/html; charset=utf-8'
    '.htm'  = 'text/html; charset=utf-8'
    '.js'   = 'application/javascript; charset=utf-8'
    '.css'  = 'text/css; charset=utf-8'
    '.json' = 'application/json; charset=utf-8'
    '.svg'  = 'image/svg+xml'
    '.png'  = 'image/png'
    '.jpg'  = 'image/jpeg'
    '.jpeg' = 'image/jpeg'
    '.gif'  = 'image/gif'
    '.ico'  = 'image/x-icon'
    '.txt'  = 'text/plain; charset=utf-8'
    '.md'   = 'text/markdown; charset=utf-8'
}

try {
    while ($listener.IsListening) {
        $context = $listener.GetContext()
        $req = $context.Request
        $res = $context.Response

        $rel = [Uri]::UnescapeDataString($req.Url.AbsolutePath).TrimStart('/')
        if ([string]::IsNullOrEmpty($rel)) { $rel = 'index.html' }
        $path = Join-Path $root $rel

        # 安全：禁止跳出根目录
        $fullRoot = (Resolve-Path $root).Path
        $fullPath = [System.IO.Path]::GetFullPath($path)
        if (-not $fullPath.StartsWith($fullRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
            $res.StatusCode = 403
            $res.Close()
            continue
        }

        if (Test-Path $fullPath -PathType Container) {
            $fullPath = Join-Path $fullPath 'index.html'
        }

        if (Test-Path $fullPath -PathType Leaf) {
            $ext = [System.IO.Path]::GetExtension($fullPath).ToLower()
            $res.ContentType = if ($mime.ContainsKey($ext)) { $mime[$ext] } else { 'application/octet-stream' }
            $bytes = [System.IO.File]::ReadAllBytes($fullPath)
            $res.ContentLength64 = $bytes.Length
            $res.OutputStream.Write($bytes, 0, $bytes.Length)
        } else {
            $res.StatusCode = 404
            $msg = [System.Text.Encoding]::UTF8.GetBytes("Not Found: $rel")
            $res.ContentType = 'text/plain; charset=utf-8'
            $res.ContentLength64 = $msg.Length
            $res.OutputStream.Write($msg, 0, $msg.Length)
        }
        $res.Close()
    }
} finally {
    $listener.Stop()
    $listener.Close()
}
