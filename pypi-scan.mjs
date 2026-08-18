/**
 * The same study, on PyPI. Metadata only, nothing installed.
 *
 * PyPI differs from npm in one way that matters to the result rather than to the
 * code: it publishes no equivalent of npm's `_npmUser`, so there is no way to ask
 * "which account pushed this version". The trust set can be counted on npm and
 * cannot be counted here, and that absence is part of what the study found.
 *
 * Two more shape differences, both handled explicitly below:
 *   - dependencies live in `requires_dist` as PEP 508 strings with markers, so
 *     extras and python-version conditions have to be filtered rather than parsed
 *     away silently.
 *   - install-time code has no flag. A source distribution with a setup.py runs
 *     code on install; a wheel does not. We read that off the release files.
 *
 * Same operational contract as registry-scan.mjs: resumable state, PAUSE file,
 * disk floor, STATUS.md.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync, renameSync, statfsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import semver from "semver";

const HERE = dirname(fileURLToPath(import.meta.url));
const CACHE = join(HERE, "cache-pypi");
const STATE = join(HERE, "state-pypi.json");
const OUT = join(HERE, "results-pypi.ndjson");
const STATUS = join(HERE, "STATUS-pypi.md");
const PAUSE = join(HERE, "PAUSE");

const MIN_FREE_GB = 20;
const MONTHS = 24;
const PYTHON = "3.12";

/** Dependency blocks of applications people actually ship. */
const STACKS = {
  flask: { flask: ">=3.0" },
  django: { django: ">=5.0" },
  fastapi: { fastapi: ">=0.115", uvicorn: ">=0.30" },
  requests: { requests: ">=2.31" },
  pandas: { pandas: ">=2.2" },
  sqlalchemy: { sqlalchemy: ">=2.0", psycopg2Binary: ">=2.9" },
  pytest: { pytest: ">=8.0" },
  celery: { celery: ">=5.4" },
  boto3: { boto3: ">=1.34" },
  "scikit-learn": { "scikit-learn": ">=1.5" },
  transformers: { transformers: ">=4.40" },
  langchain: { langchain: ">=0.3" },
  poetry: { poetry: ">=1.8" },
  httpx: { httpx: ">=0.27" },
};
/** the key above is a JS identifier in one case; map it back to the real name */
const RENAME = { psycopg2Binary: "psycopg2-binary" };

/* ---------- ops ----------------------------------------------------------- */

const freeGb = () => {
  const s = statfsSync(HERE);
  return (s.bavail * s.bsize) / 1e9;
};
const paused = () => existsSync(PAUSE);
const loadState = () =>
  existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : { started: new Date().toISOString(), done: [], fetched: 0, errors: [] };
function saveState(state) {
  writeFileSync(STATE + ".tmp", JSON.stringify(state, null, 1));
  renameSync(STATE + ".tmp", STATE);
}
function writeStatus(state, note) {
  const total = Object.keys(STACKS).length * (MONTHS + 1);
  writeFileSync(
    STATUS,
    [
      `# dep-weight / PyPI — состояние прогона`,
      ``,
      `Обновлено: ${new Date().toISOString()}`,
      `Старт: ${state.started}`,
      ``,
      `- Сделано единиц: **${state.done.length} из ${total}**`,
      `- Запросов к PyPI: ${state.fetched}`,
      `- Ошибок: ${state.errors.length}`,
      `- Свободно на диске: ${freeGb().toFixed(1)} ГБ (порог ${MIN_FREE_GB} ГБ)`,
      `- Пауза: ${paused() ? "ДА" : "нет"}`,
      ``,
      `Заметка: ${note}`,
      ``,
      "Приостановить: `touch PAUSE`. Продолжить: `rm -f PAUSE && nohup node pypi-scan.mjs >> scan-pypi.out 2>&1 &`",
    ].join("\n") + "\n"
  );
}

/* ---------- registry ------------------------------------------------------ */

mkdirSync(CACHE, { recursive: true });
const norm = (n) => n.toLowerCase().replace(/[-_.]+/g, "-");
const memo = new Map();

async function get(url, cacheKey, state) {
  if (memo.has(cacheKey)) return memo.get(cacheKey);
  const p = join(CACHE, encodeURIComponent(cacheKey) + ".json");
  if (existsSync(p)) {
    const v = JSON.parse(readFileSync(p, "utf8"));
    memo.set(cacheKey, v);
    return v;
  }
  for (let a = 0; a < 4; a++) {
    try {
      const res = await fetch(url, { headers: { accept: "application/json" } });
      if (res.status === 404) {
        const empty = { missing: true };
        writeFileSync(p, JSON.stringify(empty));
        memo.set(cacheKey, empty);
        return empty;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      state.fetched++;
      const slim = cacheKey.includes("|")
        ? {
            requires: json.info?.requires_dist ?? [],
            // A release that ships only an sdist runs setup.py on install. A wheel does not.
            sdistOnly: (json.urls ?? []).length > 0 && (json.urls ?? []).every((u) => u.packagetype === "sdist") ? 1 : 0,
            hasSdist: (json.urls ?? []).some((u) => u.packagetype === "sdist") ? 1 : 0,
            uploaded: (json.urls ?? [])[0]?.upload_time_iso_8601 ?? null,
          }
        : {
            versions: Object.fromEntries(
              Object.entries(json.releases ?? {})
                .map(([v, files]) => [v, files[0]?.upload_time_iso_8601 ?? null])
                .filter(([, t]) => t)
            ),
          };
      writeFileSync(p, JSON.stringify(slim));
      memo.set(cacheKey, slim);
      return slim;
    } catch (e) {
      if (a === 3) {
        state.errors.push(`${cacheKey}: ${String(e).slice(0, 120)}`);
        const empty = { failed: true };
        memo.set(cacheKey, empty);
        return empty;
      }
      await new Promise((r) => setTimeout(r, 400 * 2 ** a));
    }
  }
}

/* ---------- PEP 508 ------------------------------------------------------- */

/**
 * Keep only the dependencies a plain `pip install X` would pull on this Python.
 * Anything gated behind an extra is skipped: you do not get it unless you ask.
 */
function parseRequirement(line) {
  const [head, marker] = line.split(";").map((s) => s.trim());
  if (marker) {
    if (/\bextra\s*==/.test(marker)) return null;
    const m = marker.match(/python_version\s*(<=|>=|<|>|==|!=)\s*["']([^"']+)["']/);
    if (m && !semver.satisfies(semver.coerce(PYTHON), `${m[1] === "==" ? "" : m[1]}${semver.coerce(m[2])}`)) return null;
    if (/sys_platform\s*==\s*["']win32["']/.test(marker)) return null;
  }
  const name = head.match(/^([A-Za-z0-9._-]+)/)?.[1];
  if (!name) return null;
  const spec = head.slice(name.length).replace(/\[[^\]]*\]/, "").trim();
  return { name: norm(name), spec };
}

/** Translate a PEP 440 specifier set into something semver can answer. Coarse by design. */
function satisfies(version, spec) {
  const v = semver.coerce(version);
  if (!v) return false;
  if (!spec) return true;
  for (const part of spec.split(",").map((s) => s.trim()).filter(Boolean)) {
    const m = part.match(/^(==|!=|>=|<=|>|<|~=)\s*(.+)$/);
    if (!m) continue;
    const [, op, raw] = m;
    const target = semver.coerce(raw.replace(/\.\*$/, ""));
    if (!target) continue;
    const ok =
      op === "==" ? semver.eq(v, target)
      : op === "!=" ? !semver.eq(v, target)
      : op === ">=" ? semver.gte(v, target)
      : op === "<=" ? semver.lte(v, target)
      : op === ">" ? semver.gt(v, target)
      : op === "<" ? semver.lt(v, target)
      : op === "~=" ? semver.gte(v, target) && semver.lt(v, semver.inc(target, "minor"))
      : true;
    if (!ok) return false;
  }
  return true;
}

/* ---------- resolution ---------------------------------------------------- */

async function resolve(manifest, asOf, state) {
  const nodes = new Map();
  const unresolved = [];
  const queue = Object.entries(manifest).map(([k, spec]) => ({ name: norm(RENAME[k] ?? k), spec, depth: 1 }));

  while (queue.length) {
    const { name, spec, depth } = queue.shift();
    const index = await get(`https://pypi.org/pypi/${name}/json`, name, state);
    if (!index.versions) {
      unresolved.push(`${name}${spec}`);
      continue;
    }
    const candidates = Object.entries(index.versions)
      .filter(([v, t]) => new Date(t) <= asOf && !/[abrc]|dev|post/.test(v) && semver.coerce(v) && satisfies(v, spec))
      .sort((a, b) => semver.rcompare(semver.coerce(a[0]), semver.coerce(b[0])));
    if (!candidates.length) {
      unresolved.push(`${name}${spec}`);
      continue;
    }
    const [version, uploaded] = candidates[0];
    const key = `${name}@${version}`;
    if (nodes.has(key)) {
      nodes.get(key).depth = Math.min(nodes.get(key).depth, depth);
      continue;
    }
    const meta = await get(`https://pypi.org/pypi/${name}/${version}/json`, `${name}|${version}`, state);
    nodes.set(key, { name, version, depth, published: uploaded, sdistOnly: meta.sdistOnly ?? 0 });
    for (const raw of meta.requires ?? []) {
      const req = parseRequirement(raw);
      if (req) queue.push({ ...req, depth: depth + 1 });
    }
  }
  return { nodes: [...nodes.values()], unresolved };
}

function measure(stack, asOf, { nodes, unresolved }) {
  const byDepth = {};
  const ages = [];
  let sdistOnly = 0;
  for (const n of nodes) {
    byDepth[n.depth] = (byDepth[n.depth] ?? 0) + 1;
    if (n.sdistOnly) sdistOnly++;
    if (n.published) ages.push({ depth: n.depth, days: (asOf - new Date(n.published)) / 86400000 });
  }
  const median = (xs) => (xs.length ? xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)] : null);
  const ageByDepth = {};
  for (const a of ages) (ageByDepth[a.depth] ??= []).push(a.days);
  for (const d of Object.keys(ageByDepth)) ageByDepth[d] = Math.round(median(ageByDepth[d]));
  return {
    ecosystem: "pypi",
    stack,
    asOf: asOf.toISOString().slice(0, 10),
    direct: Object.keys(STACKS[stack]).length,
    packages: nodes.length,
    depth: Math.max(0, ...nodes.map((n) => n.depth)),
    byDepth,
    // PyPI publishes no per-version publisher account, so this study cannot count
    // the trust set here the way it can on npm. Reported as null, never as zero.
    publishers: null,
    sdistOnlyPackages: sdistOnly,
    medianAgeDaysByDepth: ageByDepth,
    medianAgeDays: Math.round(median(ages.map((a) => a.days)) ?? 0),
    unresolved: unresolved.length,
  };
}

/* ---------- run ----------------------------------------------------------- */

const state = loadState();
const now = new Date();
const dates = [];
for (let i = MONTHS; i >= 0; i--) dates.push(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1)));
dates[dates.length - 1] = now;

writeStatus(state, "старт");
for (const stack of Object.keys(STACKS)) {
  for (const d of dates) {
    const key = `${stack}|${d.toISOString().slice(0, 10)}`;
    if (state.done.includes(key)) continue;
    if (paused()) { writeStatus(state, "ПАУЗА"); process.exit(0); }
    if (freeGb() < MIN_FREE_GB) { writeStatus(state, "ОСТАНОВЛЕН: диск"); process.exit(1); }
    const t0 = Date.now();
    const row = measure(stack, d, await resolve(STACKS[stack], d, state));
    row.ms = Date.now() - t0;
    appendFileSync(OUT, JSON.stringify(row) + "\n");
    state.done.push(key);
    saveState(state);
    if (state.done.length % 5 === 0) writeStatus(state, `последняя единица: ${key}`);
    console.error(`${key} → ${row.packages} pkgs, depth ${row.depth}, sdist-only ${row.sdistOnlyPackages} (${row.ms}ms)`);
  }
}
writeStatus(state, "ГОТОВО");
console.error("done");
