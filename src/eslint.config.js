import tsEslint from 'typescript-eslint';

export default tsEslint.config({
  files: ['**/*.ts'],
  languageOptions: {
    parser: tsEslint.parser,
    projectService: true,
  },
  rules: {
    '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
    '@typescript-eslint/no-explicit-any': 'warn',
  },
  ignores: ['dist', 'node_modules'],
});
