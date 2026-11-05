// Scopes are this project's modules. The same list is enforced in CI through this file.
module.exports = {
  extends: ["@commitlint/config-conventional"],
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
