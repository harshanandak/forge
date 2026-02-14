const fs = require('node:fs');
const path = require('node:path');
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

describe('SECURITY.md', () => {
  const securityPath = path.join(__dirname, '..', 'SECURITY.md');

  describe('File existence', () => {
    test('should exist', () => {
      assert.ok(fs.existsSync(securityPath), 'SECURITY.md should exist');
    });
  });

  describe('Required sections', () => {
    test('should have Supported Versions section', () => {
      const content = fs.readFileSync(securityPath, 'utf-8');

      // Should have a section about supported versions
      const hasSupportedVersions = content.match(/##\s+Supported\s+Versions/i) ||
                                   content.match(/##\s+Versions/i) ||
                                   content.includes('supported version');

      assert.ok(hasSupportedVersions, 'SECURITY.md should document supported versions');
    });

    test('should have Reporting section', () => {
      const content = fs.readFileSync(securityPath, 'utf-8');

      // Should have a section about reporting vulnerabilities
      const hasReporting = content.match(/##\s+Reporting.*Vulnerability/i) ||
                          content.match(/##\s+Report/i) ||
                          content.includes('report');

      assert.ok(hasReporting, 'SECURITY.md should explain how to report vulnerabilities');
    });

    test('should have Security Policy section', () => {
      const content = fs.readFileSync(securityPath, 'utf-8');

      // Should have a security policy or main heading
      const hasPolicy = content.match(/^#\s+Security/mi) ||
                       content.includes('Security Policy');

      assert.ok(hasPolicy, 'SECURITY.md should have Security Policy heading');
    });
  });

  describe('Contact information', () => {
    test('should provide contact method for vulnerability reports', () => {
      const content = fs.readFileSync(securityPath, 'utf-8');

      // Should have email, GitHub Security Advisory, or some contact method
      const hasContact = content.includes('@') ||
                        content.includes('security advisory') ||
                        content.includes('issue tracker') ||
                        content.match(/contact/i);

      assert.ok(hasContact, 'SECURITY.md should provide contact method for reports');
    });

    test('should discourage public disclosure of vulnerabilities', () => {
      const content = fs.readFileSync(securityPath, 'utf-8');

      // Should mention not creating public issues or private disclosure
      const hasPrivateGuidance = content.match(/do\s+not.*public/i) ||
                                content.match(/private/i) ||
                                content.match(/confidential/i) ||
                                content.match(/security\s+advisory/i);

      assert.ok(hasPrivateGuidance, 'SECURITY.md should guide users to report privately');
    });
  });

  describe('Response expectations', () => {
    test('should set expectations for response timeline', () => {
      const content = fs.readFileSync(securityPath, 'utf-8');

      // Should mention timeline, response time, or acknowledgment
      const hasTimeline = content.match(/\d+\s+(days?|hours?|weeks?)/i) ||
                         content.match(/response/i) ||
                         content.match(/acknowledge/i);

      assert.ok(hasTimeline, 'SECURITY.md should set response expectations');
    });
  });

  describe('Content quality', () => {
    test('should not be empty or template-only', () => {
      const content = fs.readFileSync(securityPath, 'utf-8');

      // Should have actual content (more than 200 chars)
      assert.ok(content.length > 200, 'SECURITY.md should have substantial content');

      // Should not contain common template placeholders
      const hasPlaceholders = content.includes('[TODO]') ||
                             content.includes('INSERT') ||
                             content.includes('FILL IN');

      assert.ok(!hasPlaceholders, 'SECURITY.md should not have unfilled placeholders');
    });

    test('should be properly formatted markdown', () => {
      const content = fs.readFileSync(securityPath, 'utf-8');

      // Should have markdown headers
      const hasHeaders = content.match(/^#{1,6}\s+/m);
      assert.ok(hasHeaders, 'SECURITY.md should use markdown headers');
    });
  });
});
