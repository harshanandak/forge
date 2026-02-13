const fs = require('node:fs');
const path = require('node:path');
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const yaml = require('js-yaml');

describe('.github/workflows/size-check.yml', () => {
  const workflowPath = path.join(__dirname, '..', '..', '.github', 'workflows', 'size-check.yml');

  describe('Workflow file existence', () => {
    test('should exist', () => {
      assert.ok(fs.existsSync(workflowPath), 'size-check.yml should exist');
    });

    test('should be valid YAML', () => {
      const content = fs.readFileSync(workflowPath, 'utf-8');
      assert.doesNotThrow(() => {
        yaml.load(content);
      }, 'Should be valid YAML');
    });
  });

  describe('Workflow configuration', () => {
    let workflow;

    test('should load workflow configuration', () => {
      const content = fs.readFileSync(workflowPath, 'utf-8');
      workflow = yaml.load(content);
      assert.ok(workflow, 'Workflow should load');
    });

    test('should have name', () => {
      const content = fs.readFileSync(workflowPath, 'utf-8');
      workflow = yaml.load(content);
      assert.ok(workflow.name, 'Workflow should have name');
      assert.ok(
        workflow.name.toLowerCase().includes('size') || workflow.name.toLowerCase().includes('bundle'),
        'Workflow name should mention size or bundle'
      );
    });

    test('should trigger on push and pull_request', () => {
      const content = fs.readFileSync(workflowPath, 'utf-8');
      workflow = yaml.load(content);
      assert.ok(workflow.on, 'Workflow should have triggers');

      // Should trigger on push or pull_request
      const hasPush = workflow.on.push || workflow.on === 'push' || (Array.isArray(workflow.on) && workflow.on.includes('push'));
      const hasPR = workflow.on.pull_request || workflow.on === 'pull_request' || (Array.isArray(workflow.on) && workflow.on.includes('pull_request'));

      assert.ok(hasPush || hasPR, 'Workflow should trigger on push or pull_request');
    });
  });

  describe('Jobs configuration', () => {
    let workflow;

    test('should have at least one job', () => {
      const content = fs.readFileSync(workflowPath, 'utf-8');
      workflow = yaml.load(content);
      assert.ok(workflow.jobs, 'Workflow should have jobs');
      assert.ok(Object.keys(workflow.jobs).length > 0, 'Workflow should have at least one job');
    });

    test('should use ubuntu-latest runner', () => {
      const content = fs.readFileSync(workflowPath, 'utf-8');
      workflow = yaml.load(content);

      const jobs = Object.values(workflow.jobs);
      const hasUbuntu = jobs.some(job =>
        job['runs-on'] === 'ubuntu-latest' ||
        (Array.isArray(job['runs-on']) && job['runs-on'].includes('ubuntu-latest'))
      );

      assert.ok(hasUbuntu, 'At least one job should use ubuntu-latest');
    });

    test('should checkout code', () => {
      const content = fs.readFileSync(workflowPath, 'utf-8');
      workflow = yaml.load(content);

      const jobs = Object.values(workflow.jobs);
      const hasCheckout = jobs.some(job =>
        job.steps && job.steps.some(step =>
          step.uses && step.uses.includes('actions/checkout')
        )
      );

      assert.ok(hasCheckout, 'Workflow should checkout code');
    });
  });

  describe('Package size monitoring', () => {
    let workflow;

    test('should install dependencies', () => {
      const content = fs.readFileSync(workflowPath, 'utf-8');
      workflow = yaml.load(content);

      const jobs = Object.values(workflow.jobs);
      const hasInstall = jobs.some(job =>
        job.steps && job.steps.some(step =>
          (step.run && (
            step.run.includes('npm install') ||
            step.run.includes('bun install') ||
            step.run.includes('yarn install') ||
            step.run.includes('pnpm install')
          ))
        )
      );

      assert.ok(hasInstall, 'Workflow should install dependencies');
    });

    test('should measure package size', () => {
      const content = fs.readFileSync(workflowPath, 'utf-8');
      workflow = yaml.load(content);

      const jobs = Object.values(workflow.jobs);
      const hasSizeCheck = jobs.some(job =>
        job.steps && job.steps.some(step =>
          (step.run && (
            step.run.includes('du') ||
            step.run.includes('size') ||
            step.run.includes('bundlesize') ||
            step.run.includes('package-size')
          ))
        )
      );

      assert.ok(hasSizeCheck, 'Workflow should measure package size');
    });
  });

  describe('README badge integration', () => {
    test('README should have size badge', () => {
      const readmePath = path.join(__dirname, '..', '..', 'README.md');
      const content = fs.readFileSync(readmePath, 'utf-8');

      // Should have a badge for package size
      const hasSizeBadge = content.includes('size') && content.includes('badge');

      assert.ok(
        hasSizeBadge,
        'README should have package size badge'
      );
    });
  });
});
