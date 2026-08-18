/**
 * Rebuilds every table in RESULTS.md from the raw rows, so no number in the
 * write-up is typed by hand. `node report.mjs` prints them; diff the output
 * against RESULTS.md to check the prose against the data.
 */
import { readFileSync, existsSync } from "node:fs";

const load = (p) => (existsSync(p) ? readFileSync(p, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []);
const ECO = { npm: load("results/npm.ndjson"), pypi: load("results/pypi.ndjson"), maven: load("results/maven.ndjson") };

const median = (xs) => (xs.length ? xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)] : null);
const latest = (rows) => {
  const d = rows.map((r) => r.asOf).sort().at(-1);
  return rows.filter((r) => r.asOf === d);
};
const pad = (s, n) => String(s).padEnd(n);
const num = (s, n) => String(s).padStart(n);

console.log("# 1. Today, per stack\n");
for (const [eco, rows] of Object.entries(ECO)) {
  if (!rows.length) continue;
  console.log(`## ${eco}`);
  const head = eco === "npm"
    ? `${pad("stack", 22)}${num("pkgs", 6)}${num("depth", 6)}${num("publishers", 11)}${num("solo%", 7)}${num("scripts", 8)}${num("owners", 7)}${num("medAge", 7)}`
    : `${pad("stack", 22)}${num("pkgs", 6)}${num("depth", 6)}${num("medAge", 7)}${num("unres", 6)}`;
  console.log(head);
  for (const r of latest(rows).sort((a, b) => b.packages - a.packages)) {
    if (eco === "npm") {
      const solo = Math.round((100 * r.soloMaintainerPackages) / Math.max(1, r.packages));
      console.log(
        pad(r.stack, 22) + num(r.packages, 6) + num(r.depth, 6) + num(r.publishers, 11) +
        num(solo + "%", 7) + num(r.installScripts, 8) + num(r.installScriptOwners, 7) + num(r.medianAgeDays, 7)
      );
    } else {
      console.log(pad(r.stack, 22) + num(r.packages, 6) + num(r.depth, 6) + num(r.medianAgeDays, 7) + num(r.unresolved, 6));
    }
  }
  console.log();
}

console.log("# 2. Drift: same manifest, resolved month by month\n");
for (const [eco, rows] of Object.entries(ECO)) {
  if (!rows.length) continue;
  console.log(`## ${eco}`);
  for (const stack of [...new Set(rows.map((r) => r.stack))].sort()) {
    const srs = rows.filter((r) => r.stack === stack);
    const usable = srs.filter((r) => r.unresolved === 0 && r.packages > 0);
    if (!usable.length) continue;
    const a = usable[0], b = srs.at(-1);
    const arrow = b.packages === a.packages ? "flat" : b.packages < a.packages ? "shrank" : "grew";
    const pub = a.publishers != null ? `, publishers ${a.publishers}→${b.publishers}` : "";
    console.log(`${pad(stack, 22)} ${a.asOf} → ${b.asOf}: ${a.packages}→${b.packages} (${arrow})${pub}`);
  }
  console.log();
}

console.log("# 3. Median package age by depth (days since that package last published)\n");
console.log(`${pad("depth", 8)}${num("npm", 10)}${num("pypi", 10)}${num("maven", 10)}   (stacks contributing)`);
for (let d = 1; d <= 9; d++) {
  const cells = ["npm", "pypi", "maven"].map((eco) => {
    const xs = latest(ECO[eco] ?? []).map((r) => r.medianAgeDaysByDepth?.[d]).filter((x) => x != null);
    return xs.length ? `${Math.round(median(xs))} (${xs.length})` : "-";
  });
  console.log(pad(d, 8) + cells.map((c) => num(c, 10)).join(""));
}

console.log("\n# 4. Same job, three ecosystems\n");
const PAIRS = [
  ["web framework", ["npm", "express-api"], ["pypi", "flask"], ["maven", "spring-boot-web"]],
  ["ORM + driver", ["npm", "typeorm"], ["pypi", "sqlalchemy"], ["maven", "spring-boot-data-jpa"]],
  ["test runner", ["npm", "jest"], ["pypi", "pytest"], ["maven", "junit5"]],
  ["http client", ["npm", "axios"], ["pypi", "httpx"], ["maven", "okhttp"]],
];
console.log(`${pad("job", 18)}${num("npm", 10)}${num("pypi", 10)}${num("maven", 10)}`);
for (const [label, ...cells] of PAIRS) {
  const vals = cells.map(([eco, stack]) => latest(ECO[eco]).find((r) => r.stack === stack)?.packages ?? "-");
  console.log(pad(label, 18) + vals.map((v) => num(v, 10)).join(""));
}

console.log("\n# 5. Install-time code execution\n");
const npmToday = latest(ECO.npm);
console.log(`npm    : ${npmToday.reduce((s, r) => s + r.installScripts, 0)} packages with install hooks across ${npmToday.length} stacks`);
console.log(`         worst: ${npmToday.slice().sort((a, b) => b.installScripts - a.installScripts)[0].stack} — ` +
  `${Math.max(...npmToday.map((r) => r.installScripts))} scripts owned by ` +
  `${npmToday.slice().sort((a, b) => b.installScripts - a.installScripts)[0].installScriptOwners} distinct accounts`);
console.log(`pypi   : sdist-only packages (a source dist runs setup.py on install): ` +
  `${latest(ECO.pypi).reduce((s, r) => s + (r.sdistOnlyPackages ?? 0), 0)}`);
console.log(`maven  : not applicable — resolving a dependency never executes its code`);
