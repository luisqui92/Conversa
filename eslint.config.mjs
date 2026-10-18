import globals from 'globals';
export default [
  { ignores: ['node_modules/**','conversa-demo.html','dist/assets/**'] },
  { files: ['backend/**/*.mjs'], languageOptions: { globals: globals.node }, rules: { 'no-undef':'error', 'no-dupe-keys':'error', 'no-unreachable':'error', 'no-constant-condition':['error',{checkLoops:false}] } },
  { files: ['dist/**/*.mjs'], languageOptions: { globals: {...globals.browser,...globals.es2024} }, rules: { 'no-undef':'error','no-dupe-keys':'error','no-unreachable':'error' } }
];
