const { describe, test, expect } = require('bun:test');

const { askYesNo } = require('../lib/ui-utils');

describe('ui-utils', () => {
  describe('askYesNo', () => {
    test('returns default (false) in non-interactive mode with defaultNo=true', async () => {
      const mockQuestion = () => { throw new Error('should not prompt'); };
      const result = await askYesNo(mockQuestion, 'Continue?', true, true);
      expect(result).toBe(false);
    });

    test('returns default (true) in non-interactive mode with defaultNo=false', async () => {
      const mockQuestion = () => { throw new Error('should not prompt'); };
      const result = await askYesNo(mockQuestion, 'Continue?', false, true);
      expect(result).toBe(true);
    });

    test('returns true when user answers y', async () => {
      const mockQuestion = async () => 'y';
      const result = await askYesNo(mockQuestion, 'Continue?', true, false);
      expect(result).toBe(true);
    });

    test('returns true when user answers yes', async () => {
      const mockQuestion = async () => 'yes';
      const result = await askYesNo(mockQuestion, 'Continue?', true, false);
      expect(result).toBe(true);
    });

    test('returns false when user answers n', async () => {
      const mockQuestion = async () => 'n';
      const result = await askYesNo(mockQuestion, 'Continue?', false, false);
      expect(result).toBe(false);
    });

    test('returns false when user answers no', async () => {
      const mockQuestion = async () => 'no';
      const result = await askYesNo(mockQuestion, 'Continue?', false, false);
      expect(result).toBe(false);
    });

    test('returns default when user enters empty string with defaultNo=true', async () => {
      const mockQuestion = async () => '';
      const result = await askYesNo(mockQuestion, 'Continue?', true, false);
      expect(result).toBe(false);
    });

    test('returns default when user enters empty string with defaultNo=false', async () => {
      const mockQuestion = async () => '';
      const result = await askYesNo(mockQuestion, 'Continue?', false, false);
      expect(result).toBe(true);
    });

    test('re-prompts on invalid input then accepts valid input', async () => {
      let callCount = 0;
      const mockQuestion = async () => {
        callCount++;
        if (callCount === 1) return 'maybe';
        return 'y';
      };
      const result = await askYesNo(mockQuestion, 'Continue?', true, false);
      expect(result).toBe(true);
      expect(callCount).toBe(2);
    });
  });
});
