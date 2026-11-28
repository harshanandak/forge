import { win32 } from "node:path";
import {
  powershell,
  readInput,
  type Request,
} from "./protect-windows-reference.ts";

type Recipe = {
  row: string;
  variant: string;
  expected: boolean;
  kind?: "file" | "dir";
  shape?: "missing" | "file" | "junction" | "symlink" | "dangling";
  chain?: boolean;
  depth?: number;
  sddl?: string;
  inject?: "read" | "absent" | "custom" | "compound" | "sddl";
};

function recipes(): Recipe[] {
  const full = "0x1f01ff";
  const trusted = [
    "@",
    "SY",
    "BA",
    "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464",
  ];
  const other = "S-1-5-32-545";
  const owner = "O:@G:@D:P";
  const allow = (sid = "@", mask = full, flags = "OICI") =>
    `(A;${flags};${mask};;;${sid})`;
  const privateDir = allow();
  const readMask = "0x120089";
  const ownerRead = allow("@", readMask, "");
  const file = { kind: "file", shape: "file" } as const;
  const splitMask = allow("@", "0x00120089") + allow("@", "0x000d0176");
  const set = (
    row: string,
    variant: string,
    body: string,
    expected = false,
    extras: Partial<Recipe> = {},
  ): Recipe => ({ row, variant, expected, sddl: owner + body, ...extras });
  const check = (
    row: string,
    variant: string,
    expected = false,
    extras: Partial<Recipe> = {},
  ): Recipe => ({ row, variant, expected, ...extras });
  const chain = (
    row: string,
    variant: string,
    body: string,
    expected: boolean,
    depth = 1,
    extras: Partial<Recipe> = {},
  ) => set(row, variant, body, expected, { chain: true, depth, ...extras });
  return [
    check("01", "missing", false, { shape: "missing" }),
    check("01", "attributes access failure", false, { inject: "read" }),
    check("02", "file requested as directory", false, { shape: "file" }),
    check("02", "directory requested as file", false, { kind: "file" }),
    ...(["junction", "symlink", "dangling"] as const).map((shape) =>
      check("03", shape, false, { shape }),
    ),
    check("04", "descriptor read fails", false, { inject: "read" }),
    ...trusted
      .slice(1)
      .map((sid) =>
        set("05", sid, "", false, { sddl: `O:${sid}G:@D:P${privateDir}` }),
      ),
    set("06", "null DACL", "NO_ACCESS_CONTROL"),
    check("06", "absent DACL", false, { inject: "absent" }),
    set("07", "empty DACL", ""),
    set("08", "unprotected directory", "", false, {
      sddl: "O:@G:@D:" + privateDir,
    }),
    set("09a", "split masks on disk", splitMask, true),
    set("09a", "split masks raw", splitMask, true, { inject: "sddl" }),
    set(
      "09b",
      "three compatible owner ACEs",
      splitMask + allow("@", "0x1"),
      false,
      { inject: "sddl" },
    ),
    set(
      "09a",
      "merge inheritance flags",
      allow("@", full, "OI") + allow("@", full, "CI"),
      true,
      { inject: "sddl" },
    ),
    set(
      "09b",
      "different masks and inheritance",
      privateDir + allow("@", "0x120089", ""),
    ),
    set("10", "ordinary deny", "(D;;0x40;;;BU)" + privateDir),
    set("10", "callback allow", "(XA;;0x1f01ff;;;@;(Exists TESTATTR))", false, {
      inject: "sddl",
    }),
    set(
      "11",
      "allow for a different identity",
      privateDir + allow(other, "0x120089", ""),
    ),
    ...["", "OI", "CI", "OICINP", "OICIIO", "OICIID"].map((flags) =>
      set(
        "12",
        flags || "flags 0",
        allow("@", full, flags),
        false,
        flags.endsWith("ID") ? { inject: "sddl" } : {},
      ),
    ),
    set("13", readMask, allow("@", readMask)),
    set("13", "0x1f00ff", allow("@", "0x1f00ff")),
    set("13", "0x011f01ff", allow("@", "0x011f01ff"), false, {
      inject: "sddl",
    }),
    check("14", "protected owner with full control", true),
    set("15", "partial access", ownerRead, true, file),
    set("15", "multiple entries", ownerRead + allow("@", "0x40", "ID"), true, {
      ...file,
      inject: "sddl",
    }),
    set("15", "unusual inheritance", allow("@", readMask), true, file),
    set("15", "unprotected file", "", true, {
      ...file,
      sddl: "O:@G:@D:" + ownerRead,
    }),
    chain("16", "effective-only directory", ownerRead, true, 0),
    check("17", "missing target", false, { chain: true, shape: "missing" }),
    check("17", "target file", false, { chain: true, shape: "file" }),
    check("17", "target junction", false, { chain: true, shape: "junction" }),
    ...[0, 1, 2].map((depth) =>
      check("17", `unreadable depth ${depth}`, false, {
        chain: true,
        depth,
        inject: "read",
      }),
    ),
    chain("18", "untrusted owner", "", false, 2, {
      sddl: `O:${other}G:@D:P${privateDir}`,
    }),
    ...trusted.map((sid) =>
      chain("18", `trusted owner ${sid}`, "", true, 1, {
        sddl: `O:${sid}G:@D:P${privateDir}`,
      }),
    ),
    chain("19", "null ancestor DACL", "NO_ACCESS_CONTROL", false),
    check("19", "absent DACL", false, {
      chain: true,
      depth: 2,
      inject: "absent",
    }),
    ...(["compound", "custom"] as const).map((inject) =>
      check("20", inject, false, { chain: true, depth: 1, inject }),
    ),
    ...[
      "0x10000",
      "0x40",
      "0x40000",
      "0x80000",
      "0x40000000",
      "0x10000000",
    ].flatMap((mask, n) =>
      [0, 1, 2].map((depth) =>
        chain(
          "21",
          `${mask} at depth ${depth}`,
          privateDir + allow(other, mask, depth === 2 ? "ID" : ""),
          false,
          depth,
          n > 3 || depth === 2 ? { inject: "sddl" } : {},
        ),
      ),
    ),
    ...trusted.map((sid) =>
      chain("22", sid, privateDir + allow(sid, "0x40", ""), true),
    ),
    chain("23", "ordinary deny", "(D;;0x40;;;BU)" + privateDir, true),
    chain(
      "23",
      "object deny",
      "(OD;;0x40;11111111-2222-3333-4444-555555555555;;BU)" + privateDir,
      true,
      1,
      { inject: "sddl" },
    ),
    chain(
      "23",
      "callback deny",
      "(XD;;0x40;;;BU;(Exists TESTATTR))" + privateDir,
      true,
      1,
      { inject: "sddl" },
    ),
    chain(
      "24",
      "inherit-only replacement",
      privateDir + allow(other, "0x40", "OICIIO"),
      true,
    ),
    chain(
      "25",
      "read and create rights",
      privateDir + allow(other, "0x12008f", ""),
      true,
    ),
    chain("25", "object allow", privateDir + "(OA;;0x1;;;BU)", true, 1, {
      inject: "sddl",
    }),
    chain(
      "25",
      "callback allow",
      privateDir + "(XA;;0x1;;;BU;(Exists TESTATTR))",
      true,
      1,
      { inject: "sddl" },
    ),
    chain("26", "empty ancestor DACL", "", true),
    check("27", "all components through the root", true, { chain: true }),
    chain("28", "empty target", "", false, 0),
    chain("28", "trusted but foreign target owner", "", false, 0, {
      sddl: "O:BAG:@D:P" + privateDir,
    }),
    check("29", "private target and safe chain", true, { chain: true }),
  ];
}

const setup = `
$ErrorActionPreference = 'Stop'
$inputData = ${readInput}
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
function Encode($value) {
  $bytes = [byte[]]::new($value.BinaryLength)
  $value.GetBinaryForm($bytes, 0)
  [Convert]::ToBase64String($bytes)
}
function Raw($sddl) {
  $descriptor = [Security.AccessControl.RawSecurityDescriptor]::new($sddl.Replace('@', $sid.Value).Replace('NO_ACCESS_CONTROL', ''))
  if ($sddl.Contains('NO_ACCESS_CONTROL')) { $descriptor.DiscretionaryAcl = $null }
  $descriptor
}
$safe = Encode (Raw 'O:@G:@D:P(A;OICI;FA;;;@)')
$cases = foreach ($recipe in $inputData) {
  $descriptor = if ($recipe.sddl) { Raw $recipe.sddl } else { Raw 'O:@G:@D:P(A;OICI;FA;;;@)' }
  if ($recipe.inject -eq 'absent') {
    $descriptor.DiscretionaryAcl = $null
    $descriptor.SetFlags([Security.AccessControl.ControlFlags]::SelfRelative)
  } elseif ($recipe.inject -in 'compound','custom') {
    $ace = if ($recipe.inject -eq 'custom') {
      [Security.AccessControl.GenericAce]::CreateFromBinaryForm([byte[]]@(32, 0, 4, 0), 0)
    } else {
      [Security.AccessControl.CompoundAce]::new('None', 64, 'Impersonation', $descriptor.Owner)
    }
    $descriptor.DiscretionaryAcl.InsertAce(0, $ace)
  }
  Encode $descriptor
}
ConvertTo-Json -InputObject @{ user = (Encode $sid); safe = $safe; cases = @($cases) } -Compress
`;

export function fixtures() {
  const samples = recipes();
  const { user, safe, cases } = powershell<{
    user: string;
    safe: string;
    cases: string[];
  }>(setup, samples, 5_000);
  if (cases.length !== samples.length)
    throw new Error("Missing reference descriptor");
  return {
    user: Buffer.from(user, "base64"),
    cases: samples.map((recipe, index) => {
      const root = "C:\\";
      const ancestor = win32.join(root, `forge-acl-case-${index}`);
      const parent = win32.join(ancestor, "parent");
      const path = win32.join(parent, "target");
      const descriptors: Request["descriptors"] = {};
      for (const [depth, current] of [path, parent, ancestor, root].entries()) {
        const variant = depth === (recipe.depth ?? 0);
        if (
          (variant && recipe.inject === "read") ||
          (depth === 0 && recipe.shape && recipe.shape !== "file")
        )
          continue;
        descriptors[current] = {
          directory: depth !== 0 || recipe.shape !== "file",
          bytes: variant ? cases[index]! : safe,
        };
      }
      const { row, variant, expected } = recipe;
      return {
        row,
        variant,
        expected,
        request: {
          path,
          kind: recipe.kind ?? "dir",
          chain: recipe.chain ?? false,
          descriptors,
        },
      };
    }),
  };
}
