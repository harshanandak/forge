import assert from "node:assert/strict";
import { test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { powerShellArgs } from "../powershell.ts";

type CaseResult = {
  case: string;
  ok: boolean;
  stopCalls: number;
  message: string;
};

const root = resolve(import.meta.dirname, "../..");
const script = join(root, ".github", "scripts", "disable-storsvc.ps1");
const psQuote = (value: string) => `'${value.replaceAll("'", "''")}'`;
const driver = `
$ScriptPath = ${psQuote(script)}
$ErrorActionPreference = 'Stop'
$get = {
  [pscustomobject]@{
    Status = $global:ForgeStorSvcState
    StartType = $global:ForgeStorSvcStartType
  }
}
$disable = {
  if ($global:ForgeStorSvcDisableWorks) {
    $global:ForgeStorSvcStartType = 'Disabled'
  }
}
$stop = {
  $global:ForgeStorSvcStopCalls += 1
  if ($global:ForgeStorSvcStopMarksStopped) {
    $global:ForgeStorSvcState = 'Stopped'
  }
  if ($global:ForgeStorSvcStopThrows) {
    throw 'stop exploded'
  }
}
function Invoke-Case($Name, $State, $StartType, $StopThrows, $StopMarksStopped, $DisableWorks) {
  $global:ForgeStorSvcState = $State
  $global:ForgeStorSvcStartType = $StartType
  $global:ForgeStorSvcStopThrows = $StopThrows
  $global:ForgeStorSvcStopMarksStopped = $StopMarksStopped
  $global:ForgeStorSvcDisableWorks = $DisableWorks
  $global:ForgeStorSvcStopCalls = 0
  $message = ''
  $ok = $true
  try {
    & $ScriptPath -Get $get -Disable $disable -Stop $stop
  } catch {
    $ok = $false
    $message = $_.Exception.Message
  }
  [pscustomobject]@{
    case = $Name
    ok = $ok
    stopCalls = $global:ForgeStorSvcStopCalls
    message = $message
  }
}
$cases = @(
  Invoke-Case 'running stop succeeds' 'Running' 'Manual' $false $true $true
  Invoke-Case 'already stopped and disabled' 'Stopped' 'Disabled' $false $false $true
  Invoke-Case 'stop throws after stopping' 'Running' 'Manual' $true $true $true
  Invoke-Case 'stop throws while running' 'Running' 'Manual' $true $false $true
  Invoke-Case 'disable leaves start type manual' 'Stopped' 'Manual' $false $false $false
)
foreach ($case in $cases) {
  $case | ConvertTo-Json -Compress
}
`;

test("the shared StorSvc script verifies state with injected service adapters", () => {
  const pwsh = Bun.which("pwsh");
  if (pwsh === null) throw new Error("pwsh is required");
  const result = spawnSync(pwsh, powerShellArgs(driver), {
    encoding: "utf8",
    timeout: 25_000,
    windowsHide: true,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const results = result.stdout
    .trim()
    .split(/\r?\n/)
    .map((line) => JSON.parse(line) as CaseResult);
  assert.deepEqual(results, [
    {
      case: "running stop succeeds",
      ok: true,
      stopCalls: 1,
      message: "",
    },
    {
      case: "already stopped and disabled",
      ok: true,
      stopCalls: 0,
      message: "",
    },
    {
      case: "stop throws after stopping",
      ok: true,
      stopCalls: 1,
      message: "",
    },
    {
      case: "stop throws while running",
      ok: false,
      stopCalls: 1,
      message: "StorSvc is Running and Disabled; stop error: stop exploded",
    },
    {
      case: "disable leaves start type manual",
      ok: false,
      stopCalls: 0,
      message: "StorSvc is Stopped and Manual; stop error: none",
    },
  ]);
}, 30_000);

test("both Windows CI setup steps call the shared StorSvc script", () => {
  for (const path of [
    ".github/actions/journey-setup/action.yml",
    ".github/workflows/ci.yml",
  ]) {
    const text = readFileSync(join(root, path), "utf8");
    assert.equal(
      text.match(/\.github\/scripts\/disable-storsvc\.ps1/g)?.length ?? 0,
      1,
      path,
    );
    assert.equal(text.includes("Stop-Service StorSvc"), false, path);
  }
}, 30_000);
