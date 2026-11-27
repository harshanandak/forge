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
const workflowPaths = [
  ".github/actions/journey-setup/action.yml",
  ".github/workflows/ci.yml",
];
const stepName = "Disable the Storage Service";

function indentation(line: string) {
  return line.length - line.trimStart().length;
}

function extractRunBody(path: string) {
  const lines = readFileSync(join(root, path), "utf8").split(/\r?\n/);
  const nameIndexes = lines.flatMap((line, index) =>
    line.trim() === `name: ${stepName}` ? [index] : [],
  );
  if (nameIndexes.length !== 1)
    throw new Error(`${path} has ${nameIndexes.length} ${stepName} steps`);
  const runIndex = lines.findIndex(
    (line, index) => index > nameIndexes[0]! && /^\s*run: \|\s*$/.test(line),
  );
  if (runIndex === -1) throw new Error(`${path} has no block run body`);
  const runIndent = indentation(lines[runIndex]!);
  const block: string[] = [];
  for (let index = runIndex + 1; index < lines.length; index++) {
    const line = lines[index]!;
    if (line.trim() !== "" && indentation(line) <= runIndent) break;
    block.push(line);
  }
  const first = block.find((line) => line.trim() !== "");
  if (first === undefined) throw new Error(`${path} has an empty run body`);
  const contentIndent = indentation(first);
  return block
    .map((line) => (line.trim() === "" ? "" : line.slice(contentIndent)))
    .join("\n")
    .replace(/\n+$/, "");
}

const bodies = workflowPaths.map(extractRunBody);
const body = bodies[0]!;
const encodedBody = Buffer.from(body, "utf8").toString("base64");
const driver = `
$bodyText = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${encodedBody}'))
$body = [scriptblock]::Create($bodyText)
function global:Set-Service {
  param($Name, $StartupType)
  if ($Name -ne 'StorSvc') { throw "unexpected service $Name" }
  if ($global:ForgeStorSvcDisableWorks) {
    $global:ForgeStorSvcStartType = $StartupType
  }
}
function global:Stop-Service {
  param($Name, [switch]$Force)
  if ($Name -ne 'StorSvc') { throw "unexpected service $Name" }
  if (-not $Force) { throw 'missing Force' }
  $global:ForgeStorSvcStopCalls += 1
  if ($global:ForgeStorSvcStopMarksStopped) {
    $global:ForgeStorSvcState = 'Stopped'
  }
  if ($global:ForgeStorSvcStopThrows) {
    throw 'stop exploded'
  }
}
function global:Get-Service {
  param($Name)
  if ($Name -ne 'StorSvc') { throw "unexpected service $Name" }
  [pscustomobject]@{
    Status = $global:ForgeStorSvcState
    StartType = $global:ForgeStorSvcStartType
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
    & $body
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
Invoke-Case 'running stop succeeds' 'Running' 'Manual' $false $true $true | ConvertTo-Json -Compress
Invoke-Case 'already stopped and disabled' 'Stopped' 'Disabled' $false $false $true | ConvertTo-Json -Compress
Invoke-Case 'stop throws after stopping' 'Running' 'Manual' $true $true $true | ConvertTo-Json -Compress
Invoke-Case 'stop throws while running' 'Running' 'Manual' $true $false $true | ConvertTo-Json -Compress
Invoke-Case 'disable leaves start type manual' 'Stopped' 'Manual' $false $false $false | ConvertTo-Json -Compress
`;

test("both Windows StorSvc steps have the same inline body", () => {
  assert.equal(bodies[1], bodies[0]);
}, 30_000);

test("the inline StorSvc setup verifies state with shadowing service functions", () => {
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
