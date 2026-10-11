#!/usr/bin/env node
/** Check the catalog each UI route actually inherits, including error boundaries. */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const APP = join(ROOT, "src/app");
const EXTENSIONS = ["", ".tsx", ".ts", ".jsx", ".js", ".mjs", "/index.tsx", "/index.ts"];

function unwrap(node) {
  while (
    node &&
    (ts.isAwaitExpression(node) ||
      ts.isAsExpression(node) ||
      ts.isParenthesizedExpression(node) ||
      ts.isNonNullExpression(node))
  )
    node = node.expression;
  return node;
}

function literal(node) {
  return node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    ? node.text
    : null;
}

function scopeOf(node) {
  while (node.parent && !ts.isBlock(node) && !ts.isSourceFile(node)) node = node.parent;
  return node;
}

export function inspectSource(text, file = "surface.tsx") {
  const ast = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const imports = new Set();
  const hooks = new Set(["useTranslations", "getTranslations"]);
  const scopes = new Map();
  const namespaces = new Set();
  const keys = [];
  const dynamicKeys = [];
  const dynamic = [];
  const visit = (node, fn) => {
    fn(node);
    ts.forEachChild(node, (child) => visit(child, fn));
  };
  visit(ast, (node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      const spec = literal(node.moduleSpecifier);
      if (spec) imports.add(spec);
      if (spec === "next-intl" || spec === "next-intl/server") {
        const bindings = node.importClause?.namedBindings;
        if (bindings && ts.isNamedImports(bindings))
          for (const item of bindings.elements) {
            if (
              ["useTranslations", "getTranslations"].includes((item.propertyName || item.name).text)
            ) {
              hooks.add(item.name.text);
            }
          }
      }
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const spec = literal(node.arguments[0]);
      if (spec) imports.add(spec);
    }
    if (!ts.isVariableDeclaration(node) || !ts.isIdentifier(node.name)) return;
    const value = unwrap(node.initializer);
    if (
      !value ||
      !ts.isCallExpression(value) ||
      !ts.isIdentifier(value.expression) ||
      !hooks.has(value.expression.text)
    )
      return;
    let ns = literal(value.arguments[0]);
    if (value.arguments.length === 0) ns = "";
    if (ns === null && value.arguments[0] && ts.isObjectLiteralExpression(value.arguments[0])) {
      const property = value.arguments[0].properties.find(
        (p) => ts.isPropertyAssignment(p) && p.name.getText(ast) === "namespace"
      );
      ns = property ? literal(property.initializer) : "";
    }
    if (ns === null) {
      dynamic.push({
        line: ast.getLineAndCharacterOfPosition(value.pos).line + 1,
        expression: value.getText(ast),
      });
      return;
    }
    const scope = scopeOf(node);
    if (!scopes.has(scope)) scopes.set(scope, new Map());
    scopes.get(scope).set(node.name.text, ns);
    if (ns) namespaces.add(ns.split(".")[0]);
  });
  visit(ast, (node) => {
    if (!ts.isCallExpression(node)) return;
    const expression = node.expression;
    const target = ts.isPropertyAccessExpression(expression) ? expression.expression : expression;
    if (!ts.isIdentifier(target)) return;
    let ns;
    for (let scope = node; scope; scope = scope.parent) {
      if (scopes.get(scope)?.has(target.text)) {
        ns = scopes.get(scope).get(target.text);
        break;
      }
    }
    if (ns === undefined) return;
    const key = literal(node.arguments[0]);
    if (key === null) {
      dynamicKeys.push({
        namespace: ns,
        expression: node.getText(ast),
        line: ast.getLineAndCharacterOfPosition(node.pos).line + 1,
      });
      if (!ns && node.arguments[0] && ts.isTemplateExpression(node.arguments[0])) {
        const prefix = node.arguments[0].head.text;
        if (prefix.includes(".")) namespaces.add(prefix.split(".")[0]);
      }
      return;
    }
    const full = ns ? `${ns}.${key}` : key;
    if (!ns) namespaces.add(key.split(".")[0]);
    // .has() deliberately probes optional keys and does not render an error.
    if (!ts.isPropertyAccessExpression(expression) || expression.name.text !== "has") {
      keys.push({ key: full, line: ast.getLineAndCharacterOfPosition(node.pos).line + 1 });
    }
  });
  return {
    imports: [...imports],
    namespaces: [...namespaces],
    keys,
    dynamicKeys,
    dynamic,
    client: ast.statements.some(
      (s) => ts.isExpressionStatement(s) && literal(s.expression) === "use client"
    ),
  };
}

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === "api" || entry.name.startsWith("_") || entry.name.startsWith(".")) return [];
    const full = join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : /\.[cm]?[jt]sx?$/.test(entry.name) ? [full] : [];
  });
}

export function inheritedCatalog(file, map, app = APP) {
  let dir = dirname(file);
  // Next mounts error.tsx in the layout's children slot. It inherits that
  // layout, but cannot catch a failure in the layout itself (global-error does).
  let selected = map.root;
  const dirs = [];
  while (dir.startsWith(app)) {
    dirs.unshift(dir);
    if (dir === app) break;
    dir = dirname(dir);
  }
  for (const directory of dirs) {
    const layout = join(directory, "layout.tsx");
    if (!existsSync(layout)) continue;
    const text = readFileSync(layout, "utf8");
    const match = text.match(
      /(?:routeNamespaces|sectionNamespaces)\.(root|chrome|home|sections)(?:\["([^"]+)"\])?/
    );
    if (match) selected = match[1] === "sections" ? map.sections[match[2]] : map[match[1]];
  }
  return selected;
}

function lookup(catalog, key) {
  let value = catalog;
  for (const part of key.split(".")) {
    if (!value || !Object.hasOwn(value, part)) return undefined;
    value = value[part];
  }
  return value;
}

export function auditRoutes(root = ROOT) {
  const app = join(root, "src/app");
  const map = JSON.parse(
    readFileSync(join(root, "src/i18n/routeNamespaces.generated.json"), "utf8")
  );
  const en = JSON.parse(readFileSync(join(root, "src/i18n/messages/en.json"), "utf8"));
  const cache = new Map();
  function info(file) {
    if (!cache.has(file)) cache.set(file, inspectSource(readFileSync(file, "utf8"), file));
    return cache.get(file);
  }
  function resolveImport(spec, file) {
    const base = spec.startsWith("@/")
      ? join(root, "src", spec.slice(2))
      : spec.startsWith(".")
        ? resolve(dirname(file), spec)
        : null;
    if (!base) return null;
    return (
      EXTENSIONS.map((ext) => base + ext).find(
        (p) => existsSync(p) && statSync(p).isFile() && /\.[cm]?[jt]sx?$/.test(p)
      ) || null
    );
  }
  const gaps = [];
  const missingKeys = new Map();
  const dynamic = new Map();
  const dynamicKeys = new Map();
  const surfaces = walk(app).filter((f) =>
    /\/(page|error|loading|not-found|template|default)\.tsx$/.test(f)
  );
  for (const surface of surfaces) {
    const catalog = new Set(inheritedCatalog(surface, map, app));
    const queue = [{ file: surface, client: false }];
    const seen = new Set();
    const required = new Set();
    while (queue.length) {
      const { file, client } = queue.pop();
      const data = info(file);
      const activeClient = client || data.client;
      const state = `${file}:${activeClient}`;
      if (seen.has(state)) continue;
      seen.add(state);
      if (activeClient) for (const ns of data.namespaces) required.add(ns);
      for (const key of data.keys) {
        if (lookup(en, key.key) === undefined) {
          const item = { file: relative(root, file), ...key };
          missingKeys.set(JSON.stringify(item), item);
        }
      }
      for (const item of data.dynamic)
        dynamic.set(file + item.line, { file: relative(root, file), ...item });
      for (const item of data.dynamicKeys)
        dynamicKeys.set(file + item.line + item.expression, {
          file: relative(root, file),
          ...item,
        });
      for (const spec of data.imports) {
        const imported = resolveImport(spec, file);
        if (imported) queue.push({ file: imported, client: activeClient });
      }
    }
    const missing = [...required].filter((ns) => !catalog.has(ns));
    if (missing.length) gaps.push({ file: relative(root, surface), missing: missing.sort() });
  }
  return {
    surfaces: surfaces.length,
    modules: cache.size,
    gaps,
    missingKeys: [...missingKeys.values()],
    dynamicNamespaces: [...dynamic.values()],
    dynamicKeys: [...dynamicKeys.values()],
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = auditRoutes();
  if (process.argv.includes("--json")) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(
      `[i18n-routes] ${report.surfaces} surfaces, ${report.modules} modules: ` +
        `${report.gaps.length} catalog gaps, ${report.missingKeys.length} missing literal keys, ` +
        `${report.dynamicNamespaces.length} unresolved namespaces.`
    );
    console.log(
      `[i18n-routes] ${report.dynamicKeys.length} dynamic key references require runtime values; ` +
        "use --json for their locations."
    );
    if (report.gaps.length || report.missingKeys.length || report.dynamicNamespaces.length) {
      console.log(
        JSON.stringify(
          {
            gaps: report.gaps,
            missingKeys: report.missingKeys,
            dynamicNamespaces: report.dynamicNamespaces,
          },
          null,
          2
        )
      );
    }
  }
  if (report.gaps.length || report.missingKeys.length || report.dynamicNamespaces.length)
    process.exitCode = 1;
}
