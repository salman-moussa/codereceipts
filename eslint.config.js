import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['node_modules/', '.scratch/', 'site/'] },
  js.configs.recommended,
  {
    languageOptions: { ecmaVersion: 2023, sourceType: 'module', globals: { ...globals.node } },
    rules: { 'no-control-regex': 'off', 'no-misleading-character-class': 'off' },
  },
  {
    files: ['src/render/report-client.js'],
    languageOptions: { sourceType: 'script', globals: { ...globals.browser } },
  },
];
