const { describe, test, expect } = require("bun:test");
const { readFileSync, existsSync } = require("fs");
const { resolve } = require("path");
const yaml = require("js-yaml");

const configPath = resolve(__dirname, "../.github/dependabot.yml");

describe("dependabot.yml", () => {
  test("file exists", () => {
    expect(existsSync(configPath)).toBe(true);
  });

  test("is valid YAML", () => {
    const content = readFileSync(configPath, "utf8");
    expect(() => yaml.load(content)).not.toThrow();
  });

  test("has version 2", () => {
    const content = readFileSync(configPath, "utf8");
    const config = yaml.load(content);
    expect(config.version).toBe(2);
  });

  test("has npm and github-actions ecosystems", () => {
    const content = readFileSync(configPath, "utf8");
    const config = yaml.load(content);
    const ecosystems = config.updates.map((u) => u["package-ecosystem"]);
    expect(ecosystems).toContain("npm");
    expect(ecosystems).toContain("github-actions");
  });

  test("npm has weekly schedule on monday", () => {
    const content = readFileSync(configPath, "utf8");
    const config = yaml.load(content);
    const npm = config.updates.find((u) => u["package-ecosystem"] === "npm");
    expect(npm.schedule.interval).toBe("weekly");
    expect(npm.schedule.day).toBe("monday");
    expect(npm.schedule.time).toBe("07:00");
    expect(npm.schedule.timezone).toBe("Etc/UTC");
  });

  test("npm has production-deps and dev-deps groups", () => {
    const content = readFileSync(configPath, "utf8");
    const config = yaml.load(content);
    const npm = config.updates.find((u) => u["package-ecosystem"] === "npm");
    expect(npm.groups["production-deps"]).toBeDefined();
    expect(npm.groups["production-deps"]["dependency-type"]).toBe("production");
    expect(npm.groups["dev-deps"]).toBeDefined();
    expect(npm.groups["dev-deps"]["dependency-type"]).toBe("development");
  });

  test("npm has labels and open-pull-requests-limit", () => {
    const content = readFileSync(configPath, "utf8");
    const config = yaml.load(content);
    const npm = config.updates.find((u) => u["package-ecosystem"] === "npm");
    expect(npm.labels).toContain("dependencies");
    expect(npm["open-pull-requests-limit"]).toBe(10);
  });

  test("github-actions has weekly schedule on monday", () => {
    const content = readFileSync(configPath, "utf8");
    const config = yaml.load(content);
    const gha = config.updates.find(
      (u) => u["package-ecosystem"] === "github-actions",
    );
    expect(gha.schedule.interval).toBe("weekly");
    expect(gha.schedule.day).toBe("monday");
    expect(gha.schedule.time).toBe("07:00");
  });

  test("github-actions has groups", () => {
    const content = readFileSync(configPath, "utf8");
    const config = yaml.load(content);
    const gha = config.updates.find(
      (u) => u["package-ecosystem"] === "github-actions",
    );
    expect(gha.groups).toBeDefined();
    expect(Object.keys(gha.groups).length).toBeGreaterThanOrEqual(1);
  });

  test("github-actions has correct labels", () => {
    const content = readFileSync(configPath, "utf8");
    const config = yaml.load(content);
    const gha = config.updates.find(
      (u) => u["package-ecosystem"] === "github-actions",
    );
    expect(gha.labels).toContain("github-actions");
    expect(gha.labels).toContain("dependencies");
  });
});
