import js from "@eslint/js"
import globals from "globals"

export default [
  {
    // Generated at runtime, not ours to lint: the browser profile the launcher
    // makes, and the macOS app bundle wrapped around it.
    ignores: ["node_modules/**", ".chromium-profile/**", "**/*.app/**", ".art-plates/**"],
  },
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
    // the test suite and the art capture tool run under node, not a browser
    files: ["test/**/*.js", "tools/**/*.mjs"],
    languageOptions: { globals: { ...globals.node } },
  },
]
