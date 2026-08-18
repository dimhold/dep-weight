/**
 * What a dependency tree actually costs, per stack.
 *
 * For each recipe we install into a clean directory and measure four things
 * that are usually reported separately or not at all:
 *   installed   — packages resolved on disk (npm ls --all)
 *   depth       — longest path in that tree
 *   bytes       — what node_modules weighs
 *   loaded      — how many of those packages the process actually opens when
 *                 the entry point is required. This is the number nobody prints.
 *
 * No model is involved anywhere. Ground truth is npm's own resolution output
 * and Node's module cache, both re-derivable by rerunning this file.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const RECIPES = [
  { name: "express", deps: ["express@5"], entry: "express" },
  { name: "next", deps: ["next@15", "react@19", "react-dom@19"], entry: null },
  { name: "nestjs", deps: ["@nestjs/core@11", "@nestjs/common@11", "reflect-metadata", "rxjs"], entry: "@nestjs/core" },
  { name: "vite-react", deps: ["vite@6", "react@19", "react-dom@19"], entry: null },
  { name: "prisma", deps: ["@prisma/client@6"], entry: "@prisma/client" },
  { name: "axios", deps: ["axios"], entry: "axios" },
];

const sh = (cmd, args, cwd) =>
  execFileSync(cmd, args, { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });

/** Walk npm's own resolution tree: every distinct name@version, and the longest path. */
function walk(node, seen = new Set(), depth = 0) {
  let max = depth;
  for (const [name, child] of Object.entries(node.dependencies ?? {})) {
    if (child.version) seen.add(`${name}@${child.version}`);
    max = Math.max(max, walk(child, seen, depth + 1));
  }
  return max;
}

/** Count node_modules packages the process actually opened, not the ones installed. */
function loadedPackages(dir, entry) {
  const probe = join(dir, "probe.mjs");
  writeFileSync(
    probe,
    `import { createRequire } from "node:module";
const require = createRequire(${JSON.stringify(join(dir, "x.js"))});
require(${JSON.stringify(entry)});
const names = new Set();
for (const p of Object.keys(require.cache)) {
  const m = p.split("node_modules" + require("node:path").sep).pop();
  if (!p.includes("node_modules")) continue;
  const parts = m.split(require("node:path").sep);
  names.add(parts[0].startsWith("@") ? parts[0] + "/" + parts[1] : parts[0]);
}
console.log(JSON.stringify({ packages: names.size, files: Object.keys(require.cache).length }));`
  );
  return JSON.parse(sh("node", [probe], dir).trim());
}

const rows = [];
for (const r of RECIPES) {
  const dir = mkdtempSync(join(tmpdir(), `dep-${r.name}-`));
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "probe", private: true, version: "1.0.0" }));
  const t0 = Date.now();
  sh("npm", ["install", "--omit=dev", "--no-audit", "--no-fund", ...r.deps], dir);
  const installMs = Date.now() - t0;

  const ls = JSON.parse(sh("npm", ["ls", "--all", "--json", "--omit=dev"], dir));
  const seen = new Set();
  const depth = walk(ls, seen);
  const bytes = Number(sh("du", ["-sb", join(dir, "node_modules")]).split("\t")[0]);
  const files = Number(sh("bash", ["-c", `find ${join(dir, "node_modules")} -type f | wc -l`]).trim());

  let loaded = null;
  if (r.entry) {
    try { loaded = loadedPackages(dir, r.entry); } catch (e) { loaded = { error: String(e).slice(0, 200) }; }
  }

  const row = { stack: r.name, direct: r.deps.length, installed: seen.size, depth, bytes, files, installMs, loaded };
  rows.push(row);
  console.error(JSON.stringify(row));
}

writeFileSync(new URL("./results.json", import.meta.url), JSON.stringify({ date: new Date().toISOString().slice(0, 10), node: process.version, npm: sh("npm", ["-v"]).trim(), rows }, null, 2));
console.log(JSON.stringify(rows, null, 2));
