/**
 * The layer rules from ARCHITECTURE.md as a check. `application` must not reach
 * infrastructure or a framework, and `domain` reaches nothing outside itself.
 * Nest and MikroORM are named explicitly because a stray decorator is the usual
 * way a domain class gains a framework dependency.
 */
module.exports = {
  forbidden: [
    {
      name: "domain-is-pure",
      comment:
        "The domain imports only itself (NFR-09). Rules must be testable with no framework or database.",
      severity: "error",
      from: { path: "^src/[^/]+/domain/" },
      to: { pathNot: ["^src/[^/]+/domain/"] },
    },
    {
      name: "application-stays-inside",
      comment:
        "Application depends on domain and on its own ports, never on an adapter or framework (NFR-09).",
      severity: "error",
      from: { path: "^src/[^/]+/application/" },
      to: {
        path: ["/infrastructure/", "^src/platform/", "@nestjs", "@mikro-orm", "@aws-sdk", "prom-client"],
      },
    },
    {
      name: "platform-knows-no-business",
      comment: "Platform is reusable plumbing. A business rule there would be invisible to the domain tests.",
      severity: "error",
      from: { path: "^src/platform/" },
      to: { path: "^src/(wagering|messaging)/" },
    },
    {
      name: "no-circular",
      severity: "error",
      from: {},
      to: { circular: true },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: "tsconfig.json" },
    enhancedResolveOptions: { exportsFields: ["exports"], conditionNames: ["import", "default"] },
  },
};
