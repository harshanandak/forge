#!/usr/bin/env node

/**
 * Forge Validate CLI
 *
 * Prerequisite validation for workflow stages.
 * Helps ensure developers have required tools and files before proceeding.
 *
 * Usage:
 *   forge-validate status  - Check project prerequisites
 *   forge-validate dev     - Validate before /dev stage
 *   forge-validate ship    - Validate before /ship stage
 *
 * Security: Uses execFileSync to prevent command injection.
 */

const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

// Validation results
let checks = [];

function check(label, condition, message) {
  const passed = typeof condition === "function" ? condition() : condition;
  checks.push({ label, passed, message: passed ? "✓" : `✗ ${message}` });
  return passed;
}

function printResults() {
  console.log("\nValidation Results:\n");
  checks.forEach(({ label, passed, message }) => {
    const status = passed ? "✓" : "✗";
    const color = passed ? "\x1b[32m" : "\x1b[31m"; // green : red
    console.log(`  ${color}${status}\x1b[0m ${label}`);
    if (!passed) {
      console.log(`    ${message}`);
    }
  });
  console.log();

  const allPassed = checks.every((c) => c.passed);
  if (allPassed) {
    console.log("✅ All checks passed!\n");
  } else {
    console.log("❌ Some checks failed. Please fix the issues above.\n");
  }

  return allPassed;
}

// Validation functions

function validateStatus() {
  console.log("Checking project prerequisites...\n");

  check(
    "Git repository",
    () => {
      return fs.existsSync(".git") || fs.existsSync("../.git");
    },
    "Not a git repository. Run: git init",
  );

  check(
    "package.json exists",
    () => {
      return fs.existsSync("package.json");
    },
    "No package.json found. Run: npm init",
  );

  check(
    "Test framework configured",
    () => {
      try {
        const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
        return !!(pkg.scripts && pkg.scripts.test);
      } catch {
        return false;
      }
    },
    'No test script in package.json. Add "test" script.',
  );

  check(
    "Node.js installed",
    () => {
      try {
        execFileSync("node", ["--version"], { stdio: "pipe" });
        return true;
      } catch {
        return false;
      }
    },
    "Node.js not found. Install from nodejs.org",
  );

  return printResults();
}

function validateDev() {
  console.log("Validating prerequisites for /dev stage...\n");

  check(
    "On feature branch",
    () => {
      try {
        const branch = execFileSync(
          "git",
          ["rev-parse", "--abbrev-ref", "HEAD"],
          {
            encoding: "utf8",
          },
        ).trim();
        return (
          branch.startsWith("feat/") ||
          branch.startsWith("fix/") ||
          branch.startsWith("docs/")
        );
      } catch {
        return false;
      }
    },
    "Not on a feature branch. Create one: git checkout -b feat/your-feature",
  );

  check(
    "Plan file exists",
    () => {
      try {
        const plansDir = ".claude/plans";
        if (!fs.existsSync(plansDir)) return false;
        const plans = fs.readdirSync(plansDir).filter((f) => f.endsWith(".md"));
        return plans.length > 0;
      } catch {
        return false;
      }
    },
    "No plan file found in .claude/plans/. Run: /plan",
  );

  check(
    "Research file exists",
    () => {
      try {
        const researchDir = "docs/research";
        if (!fs.existsSync(researchDir)) return false;
        const research = fs
          .readdirSync(researchDir)
          .filter((f) => f.endsWith(".md"));
        return research.length > 0;
      } catch {
        return false;
      }
    },
    "No research file found in docs/research/. Run: /research",
  );

  check(
    "Test directory exists",
    () => {
      return (
        fs.existsSync("test") ||
        fs.existsSync("tests") ||
        fs.existsSync("__tests__")
      );
    },
    "No test directory found. Create test/ directory",
  );

  return printResults();
}

function validateShip() {
  console.log("Validating prerequisites for /ship stage...\n");

  check(
    "Tests exist",
    () => {
      const testDirs = ["test", "tests", "__tests__"];
      return testDirs.some((dir) => {
        if (!fs.existsSync(dir)) return false;
        try {
          const files = fs.readdirSync(dir, { recursive: true });
          return files.some(
            (f) => f.includes(".test.") || f.includes(".spec."),
          );
        } catch {
          return false;
        }
      });
    },
    "No test files found. Write tests before shipping!",
  );

  check(
    "Tests pass",
    () => {
      try {
        execFileSync("npm", ["test"], { stdio: "pipe" });
        return true;
      } catch {
        return false;
      }
    },
    "Tests are failing. Fix them before shipping: npm test",
  );

  check(
    "Documentation updated",
    () => {
      return fs.existsSync("README.md") || fs.existsSync("docs");
    },
    "No documentation found. Update README.md or docs/",
  );

  check(
    "No uncommitted changes",
    () => {
      try {
        const status = execFileSync("git", ["status", "--porcelain"], {
          encoding: "utf8",
        }).trim();
        return status.length === 0;
      } catch {
        return false;
      }
    },
    "Uncommitted changes found. Commit all changes before shipping.",
  );

  return printResults();
}

function showHelp() {
  console.log(`
Forge Validate - Prerequisite validation for workflow stages

Usage:
  forge-validate <command>

Commands:
  status    Check project prerequisites (git, npm, tests)
  dev       Validate before /dev stage (branch, plan, research)
  ship      Validate before /ship stage (tests pass, docs, clean)
  help      Show this help message

Examples:
  forge-validate status
  forge-validate dev
  forge-validate ship
`);
}

// Main CLI
function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (
    !command ||
    command === "help" ||
    command === "--help" ||
    command === "-h"
  ) {
    showHelp();
    process.exit(0);
  }

  let success;

  switch (command) {
    case "status":
      success = validateStatus();
      break;
    case "dev":
      success = validateDev();
      break;
    case "ship":
      success = validateShip();
      break;
    default:
      console.error(`\n❌ Unknown command: ${command}\n`);
      console.error("Valid commands: status, dev, ship, help\n");
      showHelp();
      process.exit(1);
  }

  process.exit(success ? 0 : 1);
}

// Export for testing
module.exports = {
  validateStatus,
  validateDev,
  validateShip,
};

// Run if called directly
if (require.main === module) {
  main();
}
