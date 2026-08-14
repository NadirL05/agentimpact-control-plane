import tsEslint from 'typescript-eslint';

// Corrections par rapport a la version d'origine, qui faisait echouer l'etape
// Lint de la CI a chaque execution :
//  - `projectService` appartient a parserOptions, pas a languageOptions ;
//  - les regles @typescript-eslint exigent le plugin dans le meme objet ;
//  - `src/` est un doublon mort de `core/` (exclu du tsconfig, absent du
//    conteneur) : le linter n'a pas a se prononcer dessus.
export default tsEslint.config({
  files: ['**/*.ts'],
  ignores: ['dist/**', 'node_modules/**', 'src/**', '*.config.ts'],
  plugins: {
    '@typescript-eslint': tsEslint.plugin,
  },
  languageOptions: {
    parser: tsEslint.parser,
    parserOptions: {
      projectService: true,
      tsconfigRootDir: import.meta.dirname,
    },
  },
  rules: {
    '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
    '@typescript-eslint/no-explicit-any': 'warn',
  },
});
