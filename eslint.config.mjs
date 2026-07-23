// Require braces on every control statement.
export default [
  {
    files: ["**/*.js"],
    languageOptions: { ecmaVersion: "latest", sourceType: "module" },
    rules: { curly: ["error", "all"] },
  },
];
