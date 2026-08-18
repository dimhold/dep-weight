/**
 * What a dependency tree costs, measured from registry metadata only.
 *
 * Nothing is installed. For every package we fetch the packument once, keep the
 * handful of fields we need, and resolve the graph ourselves. That buys three
 * things `npm install` cannot give:
 *
 *   1. drift        — the same manifest resolved *as of* a past date, month by
 *                     month, so we can watch a tree grow while the file that
 *                     describes it never changed.
 *   2. install code — how many packages in the tree run their own code during
 *                     install (`hasInstallScript`), how deep they sit, and how
 *                     many distinct npm accounts own them.
 *   3. people       — the accounts that actually published the versions you
 *                     would get (`_npmUser`), not the maintainer list on the
 *                     README. That is the set you extend trust to.
 *
 * Ground truth is the registry's own JSON. Every number here is re-derivable by
 * rerunning this file; no model is involved at any point.
 *
 * Operational rules, because this runs unattended on a production box:
 *   - state lives in state.json and is written after every unit of work, so a
 *     dropped connection costs one unit at most. Rerun to resume.
 *   - `touch PAUSE` stops it cleanly at the next unit; delete the file and rerun.
 *   - it refuses to start, and stops mid-run, when free disk falls under the
 *     floor set in MIN_FREE_GB.
 *   - STATUS.md is rewritten as it goes, so `cat STATUS.md` answers "where is it"
 *     without reading any code.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync, renameSync, statfsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import semver from "semver";

const HERE = dirname(fileURLToPath(import.meta.url));
const CACHE = join(HERE, "cache");
const STATE = join(HERE, "state.json");
const OUT = join(HERE, "results.ndjson");
const STATUS = join(HERE, "STATUS.md");
const PAUSE = join(HERE, "PAUSE");

const MIN_FREE_GB = 20;
const CONCURRENCY = 6;
const MONTHS = 24;

/** Real manifests, not toys: each is the dependency block of an app someone ships. */
const STACKS = {
  "express-api": { express: "^5.0.0", cors: "^2.8.5", "body-parser": "^2.0.0" },
  fastify: { fastify: "^5.0.0" },
  nestjs: { "@nestjs/core": "^11.0.0", "@nestjs/common": "^11.0.0", "reflect-metadata": "^0.2.0", rxjs: "^7.8.0" },
  next: { next: "^15.0.0", react: "^19.0.0", "react-dom": "^19.0.0" },
  "vite-react": { vite: "^6.0.0", react: "^19.0.0", "react-dom": "^19.0.0" },
  angular: { "@angular/core": "^19.0.0", "@angular/common": "^19.0.0", rxjs: "^7.8.0", "zone.js": "^0.15.0" },
  vue: { vue: "^3.5.0" },
  svelte: { svelte: "^5.0.0" },
  prisma: { "@prisma/client": "^6.0.0" },
  typeorm: { typeorm: "^0.3.0", pg: "^8.0.0" },
  jest: { jest: "^29.0.0" },
  eslint: { eslint: "^9.0.0" },
  webpack: { webpack: "^5.0.0" },
  axios: { axios: "^1.0.0" },
};

/* ---------- disk, pause, state ------------------------------------------- */

const freeGb = () => {
  const s = statfsSync(HERE);
  return (s.bavail * s.bsize) / 1e9;
};

const paused = () => existsSync(PAUSE);

const loadState = () =>
  existsSync(STATE)
    ? JSON.parse(readFileSync(STATE, "utf8"))
    : { started: new Date().toISOString(), done: [], fetched: 0, errors: [] };

function saveState(state) {
  const tmp = STATE + ".tmp";
  writeFileSync(tmp, JSON.stringify(state, null, 1));
  renameSync(tmp, STATE);
}

function writeStatus(state, note) {
  const total = Object.keys(STACKS).length * (MONTHS + 1);
  const lines = [
    `# dep-weight — состояние прогона`,
    ``,
    `Обновлено: ${new Date().toISOString()}`,
    `Старт: ${state.started}`,
    ``,
    `- Сделано единиц: **${state.done.length} из ${total}** (единица = один стек на одну дату)`,
    `- Пакетов скачано из реестра: ${state.fetched}`,
    `- Ошибок: ${state.errors.length}`,
    `- Свободно на диске: ${freeGb().toFixed(1)} ГБ (порог остановки ${MIN_FREE_GB} ГБ)`,
    `- Пауза: ${paused() ? "ДА (файл PAUSE)" : "нет"}`,
    ``,
    `Заметка: ${note}`,
    ``,
    `## Как управлять`,
    ``,
    "- Приостановить: `touch PAUSE` — остановится на ближайшей единице, состояние сохранится.",
    "- Продолжить: `rm -f PAUSE && nohup node registry-scan.mjs >> scan.out 2>> scan.err &`",
    "- Результаты по мере готовности: `results.ndjson`, одна строка на единицу.",
    "- Последние ошибки: `tail state.json`.",
  ];
  writeFileSync(STATUS, lines.join("\n") + "\n");
}

/* ---------- registry ------------------------------------------------------ */

mkdirSync(CACHE, { recursive: true });

const cachePath = (name) => join(CACHE, encodeURIComponent(name) + ".json");

/** Only the fields the study needs. A full packument is up to a few MB; this is kilobytes. */
function slim(doc) {
  const versions = {};
  for (const [v, meta] of Object.entries(doc.versions ?? {})) {
    versions[v] = {
      d: meta.dependencies ?? {},
      o: meta.optionalDependencies ?? {},
      // `hasInstallScript` only exists in the abbreviated packument, and that one
      // drops `time` and `_npmUser`. So the flag is derived here from the version's
      // own scripts block: these four hooks are the ones npm runs during install.
      s: ["preinstall", "install", "postinstall", "prepare"].some((h) => meta.scripts?.[h]) ? 1 : 0,
      u: meta._npmUser?.name ?? null,
      m: (meta.maintainers ?? []).map((x) => x.name),
      dep: meta.deprecated ? 1 : 0,
    };
  }
  return { name: doc.name, time: doc.time ?? {}, versions };
}

const memo = new Map();

async function packument(name, state) {
  if (memo.has(name)) return memo.get(name);
  const p = cachePath(name);
  if (existsSync(p)) {
    const v = JSON.parse(readFileSync(p, "utf8"));
    memo.set(name, v);
    return v;
  }
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(`https://registry.npmjs.org/${name.replace("/", "%2F")}`, {
        // The abbreviated packument is smaller but drops `time`, `maintainers` and
        // `_npmUser`, which are three of the four things this study is about.
        headers: { accept: "application/json" },
      });
      if (res.status === 404) {
        const empty = { name, time: {}, versions: {}, missing: true };
        writeFileSync(p, JSON.stringify(empty));
        memo.set(name, empty);
        return empty;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const slimmed = slim(await res.json());
      writeFileSync(p, JSON.stringify(slimmed));
      memo.set(name, slimmed);
      state.fetched++;
      return slimmed;
    } catch (e) {
      if (attempt === 3) {
        state.errors.push(`${name}: ${String(e).slice(0, 120)}`);
        const empty = { name, time: {}, versions: {}, failed: true };
        memo.set(name, empty);
        return empty;
      }
      await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
    }
  }
}

/* ---------- resolution ---------------------------------------------------- */

/** Highest version satisfying `range` that existed at `asOf`. This is the whole trick. */
function pickVersion(doc, range, asOf) {
  const candidates = [];
  for (const v of Object.keys(doc.versions)) {
    const published = doc.time[v];
    if (!published || new Date(published) > asOf) continue;
    if (doc.versions[v].dep) continue; // deprecated versions are not what a fresh install picks
    candidates.push(v);
  }
  if (!candidates.length) return null;
  const wanted = range === "latest" || range === "*" ? "*" : range;
  return semver.maxSatisfying(candidates, wanted, { includePrerelease: false }) ?? null;
}

/**
 * Walk the logical graph: every distinct name@version reachable from the manifest,
 * with the depth it first appears at. npm's own tree also hoists and dedupes on
 * disk; that changes the folder layout, not the set of code you end up trusting.
 */
async function resolve(manifest, asOf, state) {
  const nodes = new Map(); // "name@version" -> {name, version, depth, script, user, maintainers, published}
  const queue = Object.entries(manifest).map(([name, range]) => ({ name, range, depth: 1 }));
  const unresolved = [];

  while (queue.length) {
    const batch = queue.splice(0, CONCURRENCY);
    await Promise.all(
      batch.map(async ({ name, range, depth }) => {
        const doc = await packument(name, state);
        const version = pickVersion(doc, range, asOf);
        if (!version) {
          unresolved.push(`${name}@${range}`);
          return;
        }
        const key = `${name}@${version}`;
        if (nodes.has(key)) {
          const n = nodes.get(key);
          n.depth = Math.min(n.depth, depth);
          return;
        }
        const meta = doc.versions[version];
        nodes.set(key, {
          name,
          version,
          depth,
          script: meta.s,
          user: meta.u,
          maintainers: meta.m,
          published: doc.time[version] ?? null,
        });
        for (const [dn, dr] of Object.entries(meta.d)) queue.push({ name: dn, range: dr, depth: depth + 1 });
      })
    );
  }
  return { nodes: [...nodes.values()], unresolved };
}

/* ---------- metrics ------------------------------------------------------- */

function measure(stack, asOf, { nodes, unresolved }) {
  const byDepth = {};
  const publishers = new Set();
  const maintainers = new Set();
  const scriptOwners = new Set();
  let scripts = 0;
  let solo = 0;
  const ages = [];

  for (const n of nodes) {
    byDepth[n.depth] = (byDepth[n.depth] ?? 0) + 1;
    if (n.user) publishers.add(n.user);
    for (const m of n.maintainers) maintainers.add(m);
    if (n.maintainers.length === 1) solo++;
    if (n.script) {
      scripts++;
      if (n.user) scriptOwners.add(n.user);
    }
    if (n.published) ages.push({ depth: n.depth, days: (asOf - new Date(n.published)) / 86400000 });
  }

  const median = (xs) => (xs.length ? xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)] : null);
  const ageByDepth = {};
  for (const a of ages) (ageByDepth[a.depth] ??= []).push(a.days);
  for (const d of Object.keys(ageByDepth)) ageByDepth[d] = Math.round(median(ageByDepth[d]));

  return {
    stack,
    asOf: asOf.toISOString().slice(0, 10),
    direct: Object.keys(STACKS[stack]).length,
    packages: nodes.length,
    depth: Math.max(0, ...nodes.map((n) => n.depth)),
    byDepth,
    publishers: publishers.size,
    maintainers: maintainers.size,
    soloMaintainerPackages: solo,
    installScripts: scripts,
    installScriptOwners: scriptOwners.size,
    installScriptDepths: nodes.filter((n) => n.script).map((n) => n.depth).sort((a, b) => a - b),
    medianAgeDaysByDepth: ageByDepth,
    medianAgeDays: Math.round(median(ages.map((a) => a.days)) ?? 0),
    unresolved: unresolved.length,
  };
}

/* ---------- run ----------------------------------------------------------- */

const state = loadState();
if (freeGb() < MIN_FREE_GB) {
  writeStatus(state, `ОСТАНОВЛЕН НА СТАРТЕ: свободно ${freeGb().toFixed(1)} ГБ, порог ${MIN_FREE_GB} ГБ`);
  console.error("not enough free disk");
  process.exit(1);
}

const dates = [];
const now = new Date();
for (let i = MONTHS; i >= 0; i--) {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
  dates.push(d);
}
dates[dates.length - 1] = now; // last unit is "today", not the 1st of this month

const units = [];
for (const stack of Object.keys(STACKS)) for (const d of dates) units.push({ stack, d });

writeStatus(state, "старт");

for (const { stack, d } of units) {
  const key = `${stack}|${d.toISOString().slice(0, 10)}`;
  if (state.done.includes(key)) continue;
  if (paused()) {
    writeStatus(state, "ПАУЗА по файлу PAUSE, состояние сохранено");
    console.error("paused");
    process.exit(0);
  }
  if (freeGb() < MIN_FREE_GB) {
    writeStatus(state, `ОСТАНОВЛЕН: свободно ${freeGb().toFixed(1)} ГБ`);
    console.error("disk floor hit");
    process.exit(1);
  }
  const t0 = Date.now();
  const row = measure(stack, d, await resolve(STACKS[stack], d, state));
  row.ms = Date.now() - t0;
  appendFileSync(OUT, JSON.stringify(row) + "\n");
  state.done.push(key);
  saveState(state);
  if (state.done.length % 5 === 0) writeStatus(state, `последняя единица: ${key}`);
  console.error(`${key} → ${row.packages} pkgs, ${row.publishers} publishers, ${row.installScripts} install scripts (${row.ms}ms)`);
}

writeStatus(state, "ГОТОВО: все единицы посчитаны");
console.error("done");
