/**
 * UI prompt and display utilities
 * Extracted from bin/forge.js for reuse and testability
 * @module lib/ui-utils
 */

/**
 * Yes/No prompt helper.
 * @param {Function} question - Async function that prompts user and returns their answer string
 * @param {string} prompt - The prompt text to display
 * @param {boolean} [defaultNo=true] - Whether the default answer is "no"
 * @param {boolean} [nonInteractive=false] - If true, returns default without prompting
 * @returns {Promise<boolean>} User's answer
 */
async function askYesNo(question, prompt, defaultNo = true, nonInteractive = false) {
  // Non-interactive mode: return default without prompting
  if (nonInteractive) {
    const defaultValue = !defaultNo;
    console.log(`  Non-interactive mode: ${prompt} -> ${defaultValue ? 'yes' : 'no'} (default)`);
    return defaultValue;
  }
  const defaultText = defaultNo ? '[n]' : '[y]';
  while (true) {
    const answer = await question(`${prompt} (y/n) ${defaultText}: `);
    const normalized = answer.trim().toLowerCase();

    // Handle empty input (use default)
    if (normalized === '') return !defaultNo;

    // Accept yes variations
    if (normalized === 'y' || normalized === 'yes') return true;

    // Accept no variations
    if (normalized === 'n' || normalized === 'no') return false;

    // Invalid input - re-prompt
    console.log('  Please enter y or n');
  }
}

module.exports = {
  askYesNo
};
