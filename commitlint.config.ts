export default {
  extends: ["@commitlint/config-conventional"],
  rules: {
    "scope-enum": [
      1,
      "always",
      [
        "repo",
        "web",
        "api",
        "coordinator",
        "agents",
        "event-router",
        "integration",
        "indexer",
        "protocol",
        "model-router",
        "sandbox",
        "terraform",
        "migrations",
        "containers",
        "docs",
        "docs-site",
        "scripts",
      ],
    ],
  },
};
