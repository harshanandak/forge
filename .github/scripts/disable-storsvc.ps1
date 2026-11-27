param(
  [scriptblock]$Get = { Get-Service StorSvc },
  [scriptblock]$Disable = { Set-Service StorSvc -StartupType Disabled },
  [scriptblock]$Stop = { Stop-Service StorSvc -Force }
)
$ErrorActionPreference = 'Stop'
& $Disable
$service = & $Get
$stopError = 'none'
if ($service.Status -ne 'Stopped') {
  try {
    & $Stop
  } catch {
    $stopError = $_.Exception.Message
  }
}
$service = & $Get
if ($service.Status -ne 'Stopped' -or $service.StartType -ne 'Disabled') {
  throw "StorSvc is $($service.Status) and $($service.StartType); stop error: $stopError"
}
