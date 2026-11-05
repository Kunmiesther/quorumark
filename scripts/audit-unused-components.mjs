// Read-only candidate inventory, NOT an automatic deletion list.
// Static imports, re-exports and literal dynamic imports are resolved with the
// project's TypeScript config. File-based routes, UI primitives, string-based
// registries, test source inspections and external consumers require review.
import ts from "typescript";
import fs from "node:fs";
import path from "node:path";

const cwd = process.cwd();
const config = ts.readConfigFile(path.join(cwd, "tsconfig.json"), ts.sys.readFile);
if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, "\n"));
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, cwd);
const files = parsed.fileNames.filter((file) => file.startsWith(path.join(cwd, "src") + path.sep));
const incoming = new Map(files.map((file) => [file, new Set()]));
const cache = ts.createModuleResolutionCache(cwd, (name) => name, parsed.options);

for (const file of files) {
  const source = ts.createSourceFile(
    file,
    fs.readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  function visit(node) {
    let specifier;
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      specifier = node.moduleSpecifier.text;
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require")) &&
      node.arguments[0] &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      specifier = node.arguments[0].text;
    }
    if (specifier) {
      const resolved = ts.resolveModuleName(
        specifier,
        file,
        parsed.options,
        ts.sys,
        cache,
      ).resolvedModule;
      if (resolved) incoming.get(resolved.resolvedFileName)?.add(file);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
}

const candidates = [...incoming]
  .filter(
    ([file, importers]) =>
      !importers.size &&
      file.includes(`${path.sep}components${path.sep}`) &&
      !/\.(test|spec)\./.test(file),
  )
  .map(([file]) => path.relative(cwd, file))
  .sort();
console.log(
  JSON.stringify(
    {
      scannedSourceFiles: files.length,
      warning:
        "No static importers is a review signal, not proof of dead code. Check raw references and runtime registration before deleting.",
      candidates,
    },
    null,
    2,
  ),
);
