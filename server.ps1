# Local web server for index.html (Google Sheets blocks requests from file:// pages)
# -NoBrowser: run in the background without opening the browser (used by start-hidden.vbs)
param([switch]$NoBrowser)
$port = 4001
$url = "http://localhost:$port/"
$page = Join-Path $PSScriptRoot 'index.html'

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add($url)
try { $listener.Start() }
catch {
  # Already running: just open the browser
  if (-not $NoBrowser) { Start-Process $url }
  exit
}

if (-not $NoBrowser) { Start-Process $url }
Write-Host "HOSxP XE test summary is running at $url"
Write-Host "Close this window to stop."

while ($listener.IsListening) {
  $ctx = $listener.GetContext()
  $res = $ctx.Response
  $path = $ctx.Request.Url.AbsolutePath
  if ($path -eq '/' -or $path -eq '/index.html') {
    $bytes = [IO.File]::ReadAllBytes($page)
    $res.ContentType = 'text/html; charset=utf-8'
    $res.Headers.Add('Cache-Control', 'no-cache')
  } else {
    $res.StatusCode = 404
    $bytes = [Text.Encoding]::UTF8.GetBytes('Not found')
  }
  $res.ContentLength64 = $bytes.Length
  $res.OutputStream.Write($bytes, 0, $bytes.Length)
  $res.OutputStream.Close()
}
