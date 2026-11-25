import { CString, dlopen } from "bun:ffi";
import { isAbsolute, join } from "node:path";

function check(result: number, operation: string): void {
  if (!result)
    throw new Error(`${operation} failed for private test directory`);
}

function loadDirectoryCreator() {
  const systemRoot = process.env.SystemRoot ?? "";
  if (!isAbsolute(systemRoot)) throw new Error("SystemRoot must be absolute");
  const system = join(systemRoot, "System32");
  const kernel = dlopen(join(system, "kernel32.dll"), {
    GetCurrentProcess: { args: [], returns: "u64" },
    CloseHandle: { args: ["u64"], returns: "i32" },
    LocalFree: { args: ["ptr"], returns: "ptr" },
    CreateDirectoryW: { args: ["ptr", "ptr"], returns: "i32" },
  });
  const security = dlopen(join(system, "advapi32.dll"), {
    OpenProcessToken: { args: ["u64", "u32", "ptr"], returns: "i32" },
    GetTokenInformation: {
      args: ["u64", "i32", "ptr", "u32", "ptr"],
      returns: "i32",
    },
    ConvertSidToStringSidA: { args: ["ptr", "ptr"], returns: "i32" },
    ConvertStringSecurityDescriptorToSecurityDescriptorA: {
      args: ["ptr", "u32", "ptr", "ptr"],
      returns: "i32",
    },
  });
  const tokenQuery = 8;
  const tokenUserClass = 1;
  const tokenOut = Buffer.alloc(8);
  check(
    security.symbols.OpenProcessToken(
      kernel.symbols.GetCurrentProcess(),
      tokenQuery,
      tokenOut,
    ),
    "OpenProcessToken",
  );
  const token = tokenOut.readBigUInt64LE();
  let sid: string;
  try {
    const tokenUserHeaderSize = 16;
    const maxSidSize = 68;
    const tokenUser = Buffer.alloc(tokenUserHeaderSize + maxSidSize);
    check(
      security.symbols.GetTokenInformation(
        token,
        tokenUserClass,
        tokenUser,
        tokenUser.length,
        Buffer.alloc(4),
      ),
      "GetTokenInformation",
    );
    const sidOut = Buffer.alloc(8);
    check(
      security.symbols.ConvertSidToStringSidA(
        tokenUser.readBigUInt64LE(),
        sidOut,
      ),
      "ConvertSidToStringSidA",
    );
    const sidPointer = sidOut.readBigUInt64LE();
    try {
      sid = new CString(sidPointer).toString();
    } finally {
      kernel.symbols.LocalFree(sidPointer);
    }
  } finally {
    kernel.symbols.CloseHandle(token);
  }
  const sddl = Buffer.from(`O:${sid}D:P(A;OICI;FA;;;${sid})\0`, "ascii");
  return (path: string): void => {
    const descriptorOut = Buffer.alloc(8);
    check(
      security.symbols.ConvertStringSecurityDescriptorToSecurityDescriptorA(
        sddl,
        1,
        descriptorOut,
        null,
      ),
      "ConvertStringSecurityDescriptorToSecurityDescriptorA",
    );
    const descriptor = descriptorOut.readBigUInt64LE();
    try {
      const securityAttributes = Buffer.alloc(24);
      securityAttributes.writeUInt32LE(securityAttributes.length);
      securityAttributes.writeBigUInt64LE(descriptor, 8);
      check(
        kernel.symbols.CreateDirectoryW(
          Buffer.from(path + "\0", "utf16le"),
          securityAttributes,
        ),
        "CreateDirectoryW",
      );
    } finally {
      kernel.symbols.LocalFree(descriptor);
    }
  };
}

let createDirectory: ReturnType<typeof loadDirectoryCreator> | undefined;

export function createWindowsPrivateDirectory(path: string): void {
  (createDirectory ??= loadDirectoryCreator())(path);
}
