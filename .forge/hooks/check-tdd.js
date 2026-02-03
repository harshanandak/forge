#!/usr/bin/env node

/**
 * TDD Enforcement Hook
 *
 * Checks if source code changes have corresponding test files.
 * Offers guided recovery options when violations are found.
 *
 * Security: Uses execFileSync to prevent command injection.
 */

const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");

// Get staged files using git diff --cached
function getStagedFiles() {
  try {
    const output = execFileSync(
      "git",
      ["diff", "--cached", "--name-only", "--diff-filter=ACM"],
      {
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    return output.trim().split("\n").filter(Boolean);
  } catch (error) {
    console.error("Error getting staged files:", error.message);
    process.exit(1);
  }
}

// Check if a file is a source file (not test, not config)
function isSourceFile(file) {
  const sourceExtensions = [
    ".js",
    ".ts",
    ".jsx",
    ".tsx",
    ".py",
    ".go",
    ".java",
    ".rb",
  ];
  const ext = path.extname(file);

  if (!sourceExtensions.includes(ext)) return false;

  // Exclude test files
  if (file.includes(".test.") || file.includes(".spec.")) return false;

  // Exclude common config files
  const excludePatterns = [
    /^\./, // dot files
    /config\./,
    /\.config\./,
    /setup\./,
    /^test\//,
    /^tests\//,
    /__tests__\//,
    /package\.json/,
    /tsconfig/,
    /jest\.config/,
    /vite\.config/,
  ];

  return !excludePatterns.some((pattern) => pattern.test(file));
}

// Find corresponding test file for a source file
function hasTestFile(sourceFile, stagedFiles) {
  const dir = path.dirname(sourceFile);
  const basename = path.basename(sourceFile, path.extname(sourceFile));
  const ext = path.extname(sourceFile);

  // Common test patterns (including nested directories)
  const testPatterns = [
    // Colocated tests
    `${basename}.test${ext}`,
    `${basename}.spec${ext}`,
    `${dir}/${basename}.test${ext}`,
    `${dir}/${basename}.spec${ext}`,
    `${dir}/__tests__/${basename}.test${ext}`,
    `${dir}/__tests__/${basename}.spec${ext}`,
    // Top-level test directories
    `test/${basename}.test${ext}`,
    `test/${basename}.spec${ext}`,
    `tests/${basename}.test${ext}`,
    `tests/${basename}.spec${ext}`,
    `__tests__/${basename}.test${ext}`,
    `__tests__/${basename}.spec${ext}`,
    // Nested test directories (unit/integration)
    `test/unit/${basename}.test${ext}`,
    `test/unit/${basename}.spec${ext}`,
    `test/integration/${basename}.test${ext}`,
    `test/integration/${basename}.spec${ext}`,
    `tests/unit/${basename}.test${ext}`,
    `tests/unit/${basename}.spec${ext}`,
    `tests/integration/${basename}.test${ext}`,
    `tests/integration/${basename}.spec${ext}`,
  ];

  // Check if test file exists in staged files or filesystem
  for (const pattern of testPatterns) {
    if (stagedFiles.includes(pattern)) return true;
    if (fs.existsSync(pattern)) return true;
  }

  return false;
}

// Prompt user for action (handles non-TTY environments like CI/CD)
function promptUser(question, options) {
  return new Promise((resolve) => {
    // In non-interactive environments (CI/CD), auto-abort to enforce TDD
    if (!process.stdin.isTTY) {
      console.log("\n⚠️  Non-interactive environment detected (CI/CD).");
      console.log("Aborting commit - source files must have tests.");
      console.log("💡 Tip: Use --no-verify to skip this check if needed.");
      resolve("abort");
      return;
    }

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    console.log("\n" + question);
    options.forEach((opt, i) => {
      console.log(`  ${i + 1}. ${opt.label}`);
    });
    console.log();

    rl.question("Your choice (1-" + options.length + "): ", (answer) => {
      rl.close();
      const choice = parseInt(answer, 10) - 1;
      if (choice >= 0 && choice < options.length) {
        resolve(options[choice].value);
      } else {
        console.log("Invalid choice. Aborting commit.");
        resolve("abort");
      }
    });
  });
}

// Main hook logic
async function main() {
  console.log("🔍 TDD Check: Verifying test coverage for staged files...\n");

  const stagedFiles = getStagedFiles();

  if (stagedFiles.length === 0) {
    console.log("✓ No staged files to check.");
    process.exit(0);
  }

  const sourceFiles = stagedFiles.filter(isSourceFile);

  if (sourceFiles.length === 0) {
    console.log("✓ No source files staged (only tests/config/docs).");
    process.exit(0);
  }

  const filesWithoutTests = sourceFiles.filter(
    (file) => !hasTestFile(file, stagedFiles),
  );

  if (filesWithoutTests.length === 0) {
    console.log("✓ All source files have corresponding tests!");
    process.exit(0);
  }

  // Found violations
  console.log("⚠️  Looks like you're committing source code without tests:\n");
  filesWithoutTests.forEach((file) => {
    console.log(`  - ${file}`);
  });
  console.log();

  console.log("📋 TDD Reminder:");
  console.log("  Write tests BEFORE implementation (RED-GREEN-REFACTOR)");
  console.log();

  const action = await promptUser("What would you like to do?", [
    { label: "Unstage source files (keep tests staged)", value: "unstage" },
    { label: "Continue anyway (I have a good reason)", value: "continue" },
    { label: "Abort commit (let me add tests)", value: "abort" },
  ]);

  switch (action) {
    case "unstage":
      console.log("\n📝 Unstaging source files without tests...");
      filesWithoutTests.forEach((file) => {
        try {
          execFileSync("git", ["reset", "HEAD", file], { stdio: "inherit" });
          console.log(`  ✓ Unstaged: ${file}`);
        } catch (error) {
          console.error(`  ✗ Failed to unstage: ${file}`);
        }
      });
      console.log(
        "\nYou can now commit your tests and add source files later.",
      );
      process.exit(0);
      break;

    case "continue":
      console.log("\n✓ Continuing with commit...");
      console.log("💡 Tip: Use --no-verify to skip this check in emergencies.");
      process.exit(0);
      break;

    case "abort":
    default:
      console.log("\n❌ Commit aborted. Add tests and try again!");
      console.log("💡 Tip: Use --no-verify to skip this check if needed.");
      process.exit(1);
  }
}

// Run with error handling
main().catch((error) => {
  console.error("Error in TDD check hook:", error.message);
  process.exit(1);
});
