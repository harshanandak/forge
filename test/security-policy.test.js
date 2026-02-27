const fs = require('node:fs');
const path = require('node:path');
const { describe, test, expect } = require('bun:test');

describe('SECURITY.md', () => {
  const securityPath = path.join(__dirname, '..', 'SECURITY.md');

  describe('File existence', () => {
    test('should exist', () => {
      expect(fs.existsSync(securityPath)).toBeTruthy();
    });
  });

  describe('Required sections', () => {
    test('should have Supported Versions section', () => {
      const content = fs.readFileSync(securityPath, 'utf-8');

      // Should have a section about supported versions
      const hasSupportedVersions = content.match(/##\s+Supported\s+Versions/i) ||
                                   content.match(/##\s+Versions/i) ||
                                   content.includes('supported version');

      expect(hasSupportedVersions).toBeTruthy();
    });

    test('should have Reporting section', () => {
      const content = fs.readFileSync(securityPath, 'utf-8');

      // Should have a section about reporting vulnerabilities
      const hasReporting = content.match(/##\s+Reporting.*Vulnerability/i) ||
                          content.match(/##\s+Report/i) ||
                          content.includes('report');

      expect(hasReporting).toBeTruthy();
    });

    test('should have Security Policy section', () => {
      const content = fs.readFileSync(securityPath, 'utf-8');

      // Should have a security policy or main heading
      const hasPolicy = content.match(/^#\s+Security/mi) ||
                       content.includes('Security Policy');

      expect(hasPolicy).toBeTruthy();
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

      expect(hasContact).toBeTruthy();
    });

    test('should discourage public disclosure of vulnerabilities', () => {
      const content = fs.readFileSync(securityPath, 'utf-8');

      // Should mention not creating public issues or private disclosure
      const hasPrivateGuidance = content.match(/do\s+not.*public/i) ||
                                content.match(/private/i) ||
                                content.match(/confidential/i) ||
                                content.match(/security\s+advisory/i);

      expect(hasPrivateGuidance).toBeTruthy();
    });
  });

  describe('Response expectations', () => {
    test('should set expectations for response timeline', () => {
      const content = fs.readFileSync(securityPath, 'utf-8');

      // Should mention timeline, response time, or acknowledgment
      const hasTimeline = content.match(/\d+\s+(days?|hours?|weeks?)/i) ||
                         content.match(/response/i) ||
                         content.match(/acknowledge/i);

      expect(hasTimeline).toBeTruthy();
    });
  });

  describe('Content quality', () => {
    test('should not be empty or template-only', () => {
      const content = fs.readFileSync(securityPath, 'utf-8');

      // Should have actual content (more than 200 chars)
      expect(content.length > 200).toBeTruthy();

      // Should not contain common template placeholders
      const hasPlaceholders = content.includes('[TODO]') ||
                             content.includes('INSERT') ||
                             content.includes('FILL IN');

      expect(!hasPlaceholders).toBeTruthy();
    });

    test('should be properly formatted markdown', () => {
      const content = fs.readFileSync(securityPath, 'utf-8');

      // Should have markdown headers
      const hasHeaders = content.match(/^#{1,6}\s+/m);
      expect(hasHeaders).toBeTruthy();
    });
  });
});
