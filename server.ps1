# Local web server for index.html (Google Sheets blocks requests from file:// pages)
# -NoBrowser: run in the background without opening the browser (used by start-hidden.vbs)
param([switch]$NoBrowser)
$port = 4001
$url = "http://localhost:$port/"
$page = Join-Path $PSScriptRoot 'index.html'
# What's New site blocks Google Apps Script and has no CORS: the page reads it through /wn/ on this machine
$wnSite = 'https://hosxp-v4-whatsnew-00000.kube.bmscloud.in.th/'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

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
  # Allow the GitHub Pages copy of the page to call /wn/ here as well
  $res.Headers.Add('Access-Control-Allow-Origin', '*')
  $res.Headers.Add('Access-Control-Allow-Private-Network', 'true')
  if ($ctx.Request.HttpMethod -eq 'OPTIONS') {
    $bytes = @()
  } elseif ($path -match '^/wn/((assets/[\w.-]+\.js)?)$') {
    # Only the What's New home page and its .js files can be fetched
    try {
      $wc = New-Object System.Net.WebClient
      $bytes = $wc.DownloadData($wnSite + $Matches[1])
      $res.ContentType = 'text/plain; charset=utf-8'
      $res.Headers.Add('Cache-Control', 'no-store')
    } catch {
      $res.StatusCode = 502
      $bytes = [Text.Encoding]::UTF8.GetBytes("What's New: " + $_.Exception.Message)
    }
  } elseif ($path -eq '/' -or $path -eq '/index.html') {
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
