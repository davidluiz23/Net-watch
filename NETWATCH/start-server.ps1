param(
  [int]$Port = 8775,
  [switch]$Lan
)

$root = $PSScriptRoot

if ($Lan) {
  # Use Node.js if available so non-admin users can bind 0.0.0.0 without netsh urlacl
  $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
  $nodeExe = if ($nodeCmd) { $nodeCmd.Source } elseif (Test-Path 'C:\Program Files\nodejs\node.exe') { 'C:\Program Files\nodejs\node.exe' } else { $null }
  if ($nodeExe) {
    $js = @"
const http = require('http'), fs = require('fs'), path = require('path'), os = require('os');
const root = process.argv[1], port = Number(process.argv[2]);
const mime = { '.html':'text/html; charset=utf-8', '.css':'text/css; charset=utf-8', '.js':'application/javascript; charset=utf-8', '.svg':'image/svg+xml', '.json':'application/json; charset=utf-8' };
const server = http.createServer((req, res) => {
  let p = (req.url || '/').split('?')[0].replace(/^\/+/, '');
  if (!p) p = 'index.html';
  const full = path.resolve(root, p);
  if (!full.toLowerCase().startsWith(root.toLowerCase()) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) {
    res.writeHead(404); return res.end('Not found');
  }
  const ext = path.extname(full).toLowerCase();
  res.writeHead(200, { 'Content-Type': mime[ext] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  fs.createReadStream(full).pipe(res);
});
server.listen(port, '0.0.0.0', () => {
  console.log('NETWATCH dashboard serving on LAN:');
  console.log('  Local: http://localhost:' + port + '/');
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of (addrs || [])) {
      if (a.family === 'IPv4' && !a.internal && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a.address)) {
        console.log('  LAN:   http://' + a.address + ':' + port + '/  (' + name + ')');
      }
    }
  }
});
"@
    & $nodeExe -e $js $root $Port
    exit $LASTEXITCODE
  }
}

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://localhost:$Port/")
$listener.Start()
Write-Output "NETWATCH serving $root at http://localhost:$Port/"

$mimeTypes = @{
  ".html" = "text/html; charset=utf-8"
  ".css"  = "text/css; charset=utf-8"
  ".js"   = "application/javascript; charset=utf-8"
  ".svg"  = "image/svg+xml"
  ".json" = "application/json; charset=utf-8"
}

while ($listener.IsListening) {
  $ctx = $listener.GetContext()
  $reqPath = $ctx.Request.Url.LocalPath.TrimStart('/')
  if ([string]::IsNullOrWhiteSpace($reqPath)) { $reqPath = "index.html" }
  $fullPath = [System.IO.Path]::GetFullPath((Join-Path $root $reqPath))

  if (-not $fullPath.StartsWith($root, [System.StringComparison]::OrdinalIgnoreCase) -or -not (Test-Path $fullPath -PathType Leaf)) {
    $ctx.Response.StatusCode = 404
    $ctx.Response.Close()
    continue
  }

  $ext = [System.IO.Path]::GetExtension($fullPath).ToLowerInvariant()
  $ctx.Response.ContentType = if ($mimeTypes.ContainsKey($ext)) { $mimeTypes[$ext] } else { "application/octet-stream" }
  $ctx.Response.AddHeader("Cache-Control", "no-store")
  $bytes = [System.IO.File]::ReadAllBytes($fullPath)
  $ctx.Response.ContentLength64 = $bytes.Length
  $ctx.Response.OutputStream.Write($bytes, 0, $bytes.Length)
  $ctx.Response.Close()
}
