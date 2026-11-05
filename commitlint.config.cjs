// Scopes are this project's modules. The same list is enforced in CI through this file.
module.exports = {
  extends: ["@commitlint/config-conventional"],
  // Dependabot writes "Bump x" with long generated bodies, and offers no setting to change either.
  ignores: [(message) => /^(chore|ci)\(deps\): Bump /.test(message)],
  rules: {
    "scope-enum": [
      2,
      "always",
      [
        "money",
        "wallet",
        "wagering",
        "inbox",
        "outbox",
        "consumer",
        "db",
        "api",
        "obs",
        "platform",
        "test",
        "adr",
        "docs",
        "deps",
        "ci",
      ],
    ],
    "header-max-length": [2, "always", 72],
  },
};
