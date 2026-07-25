import js from "@eslint/js"
import globals from "globals"

export default [
  { ignores: ["node_modules/**"] },
  js.configs.recommended,
  {
    files: ["**/*.js", "**/*.mjs"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: { ...globals.browser },
    },
    rules: {
      curly: ["error", "all"],
      eqeqeq: ["error", "always", { null: "ignore" }],
      "no-var": "error",
      "prefer-const": "error",
      // the Renderer contract names its unimplemented parameters with a leading
      // underscore to document the interface
      "no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },
  {
    files: ["test/**/*.js"],
    languageOptions: { globals: { ...globals.node } },
  },
]
