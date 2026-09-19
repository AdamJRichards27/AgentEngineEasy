import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import ts from "typescript";

type SourceMap = Map<string, string>;

type BoundaryCategory =
  | "stage-d-commitment"
  | "stage-d-proposal-execution"
  | "communications"
  | "tasks"
  | "next-best-action"
  | "unresolved-dynamic-import";

interface ImportEdge {
  from: string;
  specifier: string;
  resolved: string | null;
  kind: "import" | "export" | "dynamic-import" | "require";
}

interface BoundaryViolation {
  category: BoundaryCategory;
  edge: ImportEdge;
}

const TEST_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const TELEPHONY_DIRECTORY = path.resolve(TEST_DIRECTORY, "..");
const API_SOURCE_DIRECTORY = path.resolve(TELEPHONY_DIRECTORY, "../..");

/**
 * Stage D's commitment creator is deliberately not imported by F3. The
 * communications and task paths below are the concrete API-side send/task
 * implementations. Grow Today is the current actionable-card/NBA read model
 * (`getGrowTodaySummary`), with its Grow AI context and coach orchestrator
 * wrappers. These concrete paths are listed in addition to the normalized
 * future path predicate so a rename cannot silently widen this boundary.
 */
const FORBIDDEN_PATHS: Array<{ category: BoundaryCategory; matches: (file: string) => boolean }> = [
  {
    category: "stage-d-commitment",
    matches: (file) => file.endsWith("/lib/growCommitmentActions.ts"),
  },
  {
    category: "stage-d-proposal-execution",
    matches: (file) =>
      file.endsWith("/lib/ai/actionRequests.ts") ||
      file.endsWith("/lib/ai/executionGateway.ts") ||
      file.includes("/lib/ai/actions/"),
  },
  {
    category: "communications",
    matches: (file) =>
      file.includes("/lib/communications/") ||
      file.endsWith("/lib/communications.ts") ||
      file.endsWith("/lib/financial/communications.ts"),
  },
  {
    category: "tasks",
    matches: (file) =>
      file.endsWith("/lib/automation/tasks.ts") ||
      file.endsWith("/routes/tasks.ts"),
  },
  {
    category: "next-best-action",
    matches: (file) =>
      file.endsWith("/lib/growToday.ts") ||
      file.endsWith("/lib/ai/context/growContext.ts") ||
      file.endsWith("/lib/ai/orchestrator.ts") ||
      file.endsWith("/lib/ai/coaching/responseBuilder.ts") ||
      file.endsWith("/routes/grow.ts") ||
      /\/(?:next[-_]?best[-_]?action|nextBestAction)(?:\.[cm]?[jt]sx?)?$/.test(file),
  },
];

function normalize(file: string): string {
  return file.split(path.sep).join("/");
}

function sourceFileName(file: string): string {
  return normalize(path.resolve(file));
}

function moduleSpecifier(node: ts.Node): string | null {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return null;
}

function candidateFiles(file: string): string[] {
  const withoutKnownExtension = file.replace(/\.(?:[cm]?tsx?|jsx?)$/, "");
  return [
    file,
    `${withoutKnownExtension}.ts`,
    `${withoutKnownExtension}.tsx`,
    `${withoutKnownExtension}.js`,
    `${withoutKnownExtension}.mjs`,
    path.join(file, "index.ts"),
    path.join(file, "index.tsx"),
  ];
}

function resolveSpecifier(from: string, specifier: string, sources: SourceMap): string | null {
  if (!specifier.startsWith(".")) return null;
  const requested = sourceFileName(path.resolve(path.dirname(from), specifier));
  for (const candidate of candidateFiles(requested)) {
    const normalized = sourceFileName(candidate);
    if (sources.has(normalized)) return normalized;
  }
  return null;
}

function collectEdges(file: string, source: string, sources: SourceMap): ImportEdge[] {
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const edges: ImportEdge[] = [];
  const add = (specifier: string, kind: ImportEdge["kind"]) => {
    edges.push({
      from: file,
      specifier,
      resolved: resolveSpecifier(file, specifier, sources),
      kind,
    });
  };

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      const specifier = node.moduleSpecifier && moduleSpecifier(node.moduleSpecifier);
      if (specifier) add(specifier, ts.isImportDeclaration(node) ? "import" : "export");
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      const specifier = moduleSpecifier(node.moduleReference.expression);
      if (specifier) add(specifier, "import");
    } else if (ts.isCallExpression(node)) {
      const first = node.arguments[0];
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword && first) {
        const specifier = moduleSpecifier(first);
        if (specifier) {
          add(specifier, "dynamic-import");
        } else {
          edges.push({
            from: file,
            specifier: "<computed dynamic import>",
            resolved: null,
            kind: "dynamic-import",
          });
        }
      } else if (
        ts.isIdentifier(node.expression) &&
        node.expression.text === "require" &&
        first
      ) {
        const specifier = moduleSpecifier(first);
        if (specifier) add(specifier, "require");
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  return edges;
}

function boundaryCategory(file: string): BoundaryCategory | null {
  return FORBIDDEN_PATHS.find(({ matches }) => matches(sourceFileName(file)))?.category ?? null;
}

function analyzeGraph(entries: string[], initialSources: SourceMap): BoundaryViolation[] {
  const sources = new Map(initialSources);
  const pending = entries.map(sourceFileName);
  const visited = new Set<string>();
  const violations: BoundaryViolation[] = [];

  while (pending.length > 0) {
    const file = pending.pop()!;
    if (visited.has(file)) continue;
    visited.add(file);
    const source = sources.get(file);
    if (source === undefined) continue;
    for (const edge of collectEdges(file, source, sources)) {
      if (edge.kind === "dynamic-import" && edge.resolved === null && edge.specifier === "<computed dynamic import>") {
        violations.push({ category: "unresolved-dynamic-import", edge });
      }
      const category = edge.resolved && boundaryCategory(edge.resolved);
      if (category) violations.push({ category, edge });
      if (edge.resolved && !visited.has(edge.resolved)) pending.push(edge.resolved);
    }
  }
  return violations;
}

function readProductionSources(entries: string[]): SourceMap {
  const sources: SourceMap = new Map();
  const pending = [API_SOURCE_DIRECTORY];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        pending.push(file);
      } else if (entry.isFile() && /\.(?:tsx?|mts|cts)$/.test(entry.name)) {
        sources.set(sourceFileName(file), fs.readFileSync(file, "utf8"));
      }
    }
  }
  // Keep the assertion tied to the requested entries, rather than letting a
  // future source-tree layout silently turn this into an empty graph.
  for (const entry of entries) assert.ok(sources.has(sourceFileName(entry)), `missing source ${entry}`);
  return sources;
}

function productionEntries(): string[] {
  const transcriptionFiles = fs.readdirSync(TELEPHONY_DIRECTORY)
    .filter((file) => /^callTranscription.*\.ts$/.test(file))
    .map((file) => path.join(TELEPHONY_DIRECTORY, file));
  const growCallsRoute = path.join(API_SOURCE_DIRECTORY, "routes/growCalls.ts");
  assert.ok(fs.existsSync(growCallsRoute), "growCalls.ts must remain in the F3 boundary");
  assert.ok(
    transcriptionFiles.some((file) => path.basename(file) === "callTranscriptionTimeline.ts"),
    "the review-save Timeline helper must remain covered",
  );
  return [...transcriptionFiles, growCallsRoute];
}

function describeViolations(violations: BoundaryViolation[]): string {
  return violations
    .map(({ category, edge }) => `${category}: ${edge.from} ${edge.kind} ${edge.specifier} -> ${edge.resolved}`)
    .join("\n");
}

test("F3 production graph has no imports into Stage D, communications, task, or NBA modules", () => {
  const entries = productionEntries();
  const sources = readProductionSources(entries);
  const violations = analyzeGraph(entries, sources);
  assert.deepEqual(violations, [], describeViolations(violations));
});

test("boundary parser catches direct, wrapper, export, require, and dynamic-import violations", () => {
  const root = sourceFileName("/virtual/src/root.ts");
  const wrapper = sourceFileName("/virtual/src/wrapper.ts");
  const sources: SourceMap = new Map([
    [root, `
      import "./lib/growCommitmentActions";
      export * from "./lib/communications/messages";
      const task = require("./lib/automation/tasks");
      void import("./lib/nextBestAction");
      const computedModule = "./lib/ai/orchestrator";
      void import(computedModule);
      void import("./wrapper");
    `],
    [wrapper, `
      export { createApprovedGrowCommitment } from "./lib/growCommitmentActions";
      export * from "./lib/communications/messages";
      const tasks = require("./lib/automation/tasks");
      void import("./lib/nextBestAction");
      export * from "./lib/growToday";
      export * from "./lib/ai/context/growContext";
      import "./lib/ai/actionRequests";
      import "./lib/ai/executionGateway";
      import "./lib/ai/actions/registry";
    `],
    [sourceFileName("/virtual/src/lib/growCommitmentActions.ts"), "export const createApprovedGrowCommitment = () => {};"],
    [sourceFileName("/virtual/src/lib/communications/messages.ts"), "export const send = () => {};"],
    [sourceFileName("/virtual/src/lib/automation/tasks.ts"), "export const createTask = () => {};"],
    [sourceFileName("/virtual/src/lib/nextBestAction.ts"), "export const nextBestAction = () => {};"],
    [sourceFileName("/virtual/src/lib/growToday.ts"), "export const getGrowTodaySummary = () => {};"],
    [sourceFileName("/virtual/src/lib/ai/context/growContext.ts"), "export const getGrowContext = () => {};"],
    [sourceFileName("/virtual/src/lib/ai/actionRequests.ts"), "export const proposeAIAction = () => {};"],
    [sourceFileName("/virtual/src/lib/ai/executionGateway.ts"), "export const executeAIAction = () => {};"],
    [sourceFileName("/virtual/src/lib/ai/actions/registry.ts"), "export const getActionDefinition = () => {};"],
  ]);
  const virtualForbidden = [
    [sourceFileName("/virtual/src/lib/growCommitmentActions.ts"), "stage-d-commitment"],
    [sourceFileName("/virtual/src/lib/ai/actionRequests.ts"), "stage-d-proposal-execution"],
    [sourceFileName("/virtual/src/lib/ai/executionGateway.ts"), "stage-d-proposal-execution"],
    [sourceFileName("/virtual/src/lib/ai/actions/registry.ts"), "stage-d-proposal-execution"],
    [sourceFileName("/virtual/src/lib/communications/messages.ts"), "communications"],
    [sourceFileName("/virtual/src/lib/automation/tasks.ts"), "tasks"],
    [sourceFileName("/virtual/src/lib/nextBestAction.ts"), "next-best-action"],
    [sourceFileName("/virtual/src/lib/growToday.ts"), "next-best-action"],
    [sourceFileName("/virtual/src/lib/ai/context/growContext.ts"), "next-best-action"],
  ] as const;
  const violations = analyzeGraph([root], sources);
  for (const [file, category] of virtualForbidden) {
    assert.ok(
      violations.some((violation) => violation.category === category && violation.edge.resolved === file),
      `parser missed ${category} edge to ${file}\n${describeViolations(violations)}`,
    );
  }
  assert.ok(violations.some(({ edge }) => edge.kind === "dynamic-import"));
  assert.ok(violations.some(({ edge }) => edge.kind === "require"));
  assert.ok(violations.some(({ edge }) => edge.kind === "export"));
  assert.ok(
    violations.some(({ category }) => category === "unresolved-dynamic-import"),
    "computed dynamic imports must fail closed",
  );
});