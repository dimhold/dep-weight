/**
 * The same study, on Maven Central. POMs only, nothing downloaded but XML.
 *
 * Maven differs from npm in three ways that are findings rather than
 * inconveniences, so each is measured rather than papered over:
 *
 *   1. No install-time code. Resolving a Maven dependency never executes
 *      anything from that dependency. There is no `postinstall` to count, so the
 *      npm number this study reports (jest: 14 install scripts owned by 11
 *      accounts) has no Maven counterpart at all. That is the comparison.
 *   2. No publisher identity. A POM lists `<developers>`, which is prose the
 *      author wrote, not the account that pushed the bits. Reported as null.
 *   3. Version ranges are rare. Almost every POM pins an exact version, and BOMs
 *      pin the rest, so "the tree drifts while your file does not" should be much
 *      weaker here. Whether it is, is the thing to measure.
 *
 * Resolution implemented: parent POMs, property interpolation,
 * dependencyManagement including imported BOMs, scope and optional filtering.
 * Not implemented: profiles, exclusions, classifiers, relocation. Each of those
 * shrinks a real tree slightly, so the numbers here are an upper bound and the
 * README says so.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync, renameSync, statfsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CACHE = join(HERE, "cache-maven");
const STATE = join(HERE, "state-maven.json");
const OUT = join(HERE, "results-maven.ndjson");
const STATUS = join(HERE, "STATUS-maven.md");
const PAUSE = join(HERE, "PAUSE");
const BASE = "https://repo1.maven.org/maven2";

const MIN_FREE_GB = 20;
const MONTHS = 24;

/** Dependency blocks of applications people actually ship on the JVM. */
const STACKS = {
  "spring-boot-web": [["org.springframework.boot", "spring-boot-starter-web"]],
  "spring-boot-data-jpa": [["org.springframework.boot", "spring-boot-starter-data-jpa"], ["org.postgresql", "postgresql"]],
  "spring-boot-security": [["org.springframework.boot", "spring-boot-starter-security"]],
  quarkus: [["io.quarkus", "quarkus-resteasy-reactive"]],
  micronaut: [["io.micronaut", "micronaut-http-server-netty"]],
  vertx: [["io.vertx", "vertx-web"]],
  jackson: [["com.fasterxml.jackson.core", "jackson-databind"]],
  hibernate: [["org.hibernate.orm", "hibernate-core"]],
  junit5: [["org.junit.jupiter", "junit-jupiter"]],
  okhttp: [["com.squareup.okhttp3", "okhttp"]],
  guava: [["com.google.guava", "guava"]],
  kafka: [["org.apache.kafka", "kafka-clients"]],
  netty: [["io.netty", "netty-all"]],
  log4j: [["org.apache.logging.log4j", "log4j-core"]],
};

/* ---------- ops ----------------------------------------------------------- */

const freeGb = () => { const s = statfsSync(HERE); return (s.bavail * s.bsize) / 1e9; };
const paused = () => existsSync(PAUSE);
const loadState = () =>
  existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : { started: new Date().toISOString(), done: [], fetched: 0, errors: [] };
const saveState = (s) => { writeFileSync(STATE + ".tmp", JSON.stringify(s, null, 1)); renameSync(STATE + ".tmp", STATE); };
function writeStatus(state, note) {
  const total = Object.keys(STACKS).length * (MONTHS + 1);
  writeFileSync(STATUS, [
    `# dep-weight / Maven — состояние прогона`, ``,
    `Обновлено: ${new Date().toISOString()}`, `Старт: ${state.started}`, ``,
    `- Сделано единиц: **${state.done.length} из ${total}**`,
    `- Запросов к Maven Central: ${state.fetched}`,
    `- Ошибок: ${state.errors.length}`,
    `- Свободно: ${freeGb().toFixed(1)} ГБ (порог ${MIN_FREE_GB} ГБ)`,
    `- Пауза: ${paused() ? "ДА" : "нет"}`, ``,
    `Заметка: ${note}`, ``,
    "Приостановить: `touch PAUSE`. Продолжить: `rm -f PAUSE && nohup node maven-scan.mjs >> scan-maven.out 2>&1 &`",
  ].join("\n") + "\n");
}

/* ---------- fetch + cache ------------------------------------------------- */

mkdirSync(CACHE, { recursive: true });
const memo = new Map();

async function text(url, key, state) {
  if (memo.has(key)) return memo.get(key);
  const p = join(CACHE, encodeURIComponent(key));
  if (existsSync(p)) { const v = readFileSync(p, "utf8"); memo.set(key, v); return v; }
  for (let a = 0; a < 4; a++) {
    try {
      const res = await fetch(url);
      if (res.status === 404) { writeFileSync(p, ""); memo.set(key, ""); return ""; }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const t = await res.text();
      writeFileSync(p, t);
      memo.set(key, t);
      state.fetched++;
      return t;
    } catch (e) {
      if (a === 3) { state.errors.push(`${key}: ${String(e).slice(0, 120)}`); memo.set(key, ""); return ""; }
      await new Promise((r) => setTimeout(r, 400 * 2 ** a));
    }
  }
}

const path = (g, a) => `${g.replace(/\./g, "/")}/${a}`;

/** Version list with publish dates, read off Central's own directory listing. */
async function versions(g, a, state) {
  const key = `list|${g}|${a}`;
  if (memo.has(key)) return memo.get(key);
  const html = await text(`${BASE}/${path(g, a)}/`, key + ".html", state);
  const out = {};
  // Central's listing puts a title attribute between the href and the text, so the
  // anchor cannot be matched with a bare `">`. Missing that silently yields an empty
  // version list, which reads as "artifact does not exist" rather than as a bug.
  for (const m of html.matchAll(/<a href="([^"/]+)\/"[^>]*>[^<]*<\/a>\s+(\d{4}-\d{2}-\d{2} \d{2}:\d{2})/g)) {
    out[m[1]] = new Date(m[2].replace(" ", "T") + ":00Z");
  }
  memo.set(key, out);
  return out;
}

/* ---------- POM ----------------------------------------------------------- */

const tag = (xml, name) => xml.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`))?.[1]?.trim() ?? null;
const blocks = (xml, name) => [...xml.matchAll(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, "g"))].map((m) => m[1]);

/** Strip comments so commented-out dependencies never enter the graph. */
const clean = (xml) => xml.replace(/<!--[\s\S]*?-->/g, "");

function parseDeps(section) {
  return blocks(section, "dependency").map((d) => ({
    g: tag(d, "groupId"),
    a: tag(d, "artifactId"),
    v: tag(d, "version"),
    scope: tag(d, "scope") ?? "compile",
    optional: tag(d, "optional") === "true",
    type: tag(d, "type") ?? "jar",
  }));
}

/** Resolve ${...} against the accumulated property map. Two passes handle nesting. */
function interp(value, props) {
  if (!value) return value;
  let out = value;
  for (let i = 0; i < 2; i++) out = out.replace(/\$\{([^}]+)\}/g, (m, k) => props[k] ?? m);
  return out;
}

/**
 * Load a POM plus everything it inherits: parent chain for properties and
 * dependencyManagement, and any BOM it imports. Returns the effective view this
 * study needs, not a full Maven model.
 */
async function effectivePom(g, a, v, state, seen = new Set()) {
  const key = `${g}:${a}:${v}`;
  if (seen.has(key)) return { props: {}, managed: {}, deps: [] };
  seen.add(key);
  const xml = clean(await text(`${BASE}/${path(g, a)}/${v}/${a}-${v}.pom`, `pom|${key}`, state));
  if (!xml) return { props: {}, managed: {}, deps: [] };

  const project = xml.replace(/<parent>[\s\S]*?<\/parent>/, "");
  const parentBlock = xml.match(/<parent>([\s\S]*?)<\/parent>/)?.[1];
  let props = {};
  let managed = {};
  let deps = [];

  if (parentBlock) {
    const pg = tag(parentBlock, "groupId"), pa = tag(parentBlock, "artifactId"), pv = tag(parentBlock, "version");
    if (pg && pa && pv) {
      const parent = await effectivePom(pg, pa, pv, state, seen);
      props = { ...parent.props };
      managed = { ...parent.managed };
    }
  }

  props["project.version"] = v;
  props["project.groupId"] = g;
  props["pom.version"] = v;
  const propBlock = project.match(/<properties>([\s\S]*?)<\/properties>/)?.[1] ?? "";
  for (const m of propBlock.matchAll(/<([^\s/>]+)>([^<]*)<\/\1>/g)) props[m[1]] = m[2].trim();

  const dm = project.match(/<dependencyManagement>([\s\S]*?)<\/dependencyManagement>/)?.[1] ?? "";
  for (const d of parseDeps(dm)) {
    const dg = interp(d.g, props), da = interp(d.a, props), dv = interp(d.v, props);
    if (d.scope === "import" && d.type === "pom" && dg && da && dv) {
      const bom = await effectivePom(dg, da, dv, state, seen);
      managed = { ...managed, ...bom.managed };
      props = { ...bom.props, ...props };
      continue;
    }
    if (dg && da && dv) managed[`${dg}:${da}`] = dv;
  }

  const depsBlock = project.replace(/<dependencyManagement>[\s\S]*?<\/dependencyManagement>/, "");
  deps = parseDeps(depsBlock.match(/<dependencies>([\s\S]*?)<\/dependencies>/)?.[1] ?? "")
    .filter((d) => !d.optional && ["compile", "runtime"].includes(d.scope) && d.type === "jar")
    .map((d) => ({ g: interp(d.g, props), a: interp(d.a, props), v: interp(d.v, props) }));

  return { props, managed, deps };
}

/* ---------- resolution ---------------------------------------------------- */

async function resolve(roots, asOf, state) {
  const nodes = new Map();
  const unresolved = [];
  const queue = roots.map(([g, a]) => ({ g, a, v: null, depth: 1, managed: {} }));

  while (queue.length) {
    const item = queue.shift();
    const { g, a, depth } = item;
    if (!g || !a) continue;

    let v = item.v && !item.v.includes("${") ? item.v : item.managed[`${g}:${a}`] ?? null;
    const list = await versions(g, a, state);
    const dated = Object.entries(list).filter(([, d]) => d <= asOf);
    if (v && !list[v]) v = null;
    if (v && list[v] > asOf) v = null;
    if (!v) {
      // No pin reachable: take the newest release that existed on that date.
      const releases = dated
        .filter(([ver]) => !/(alpha|beta|rc|-M\d|snapshot|preview)/i.test(ver))
        .sort((x, y) => y[1] - x[1]);
      v = releases[0]?.[0] ?? null;
    }
    if (!v) { unresolved.push(`${g}:${a}`); continue; }

    const key = `${g}:${a}:${v}`;
    if (nodes.has(key)) { nodes.get(key).depth = Math.min(nodes.get(key).depth, depth); continue; }
    const pom = await effectivePom(g, a, v, state);
    nodes.set(key, { g, a, v, depth, published: list[v]?.toISOString() ?? null });
    for (const d of pom.deps) queue.push({ g: d.g, a: d.a, v: d.v, depth: depth + 1, managed: pom.managed });
  }
  return { nodes: [...nodes.values()], unresolved };
}

function measure(stack, asOf, { nodes, unresolved }) {
  const byDepth = {};
  const groups = new Set();
  const ages = [];
  for (const n of nodes) {
    byDepth[n.depth] = (byDepth[n.depth] ?? 0) + 1;
    groups.add(n.g);
    if (n.published) ages.push({ depth: n.depth, days: (asOf - new Date(n.published)) / 86400000 });
  }
  const median = (xs) => (xs.length ? xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)] : null);
  const ageByDepth = {};
  for (const x of ages) (ageByDepth[x.depth] ??= []).push(x.days);
  for (const d of Object.keys(ageByDepth)) ageByDepth[d] = Math.round(median(ageByDepth[d]));
  return {
    ecosystem: "maven",
    stack,
    asOf: asOf.toISOString().slice(0, 10),
    direct: STACKS[stack].length,
    packages: nodes.length,
    depth: Math.max(0, ...nodes.map((n) => n.depth)),
    byDepth,
    // Maven Central publishes no per-version account, only prose in <developers>.
    publishers: null,
    // Resolution never executes dependency code on this ecosystem. Not zero found:
    // zero possible. Kept explicit so the cross-ecosystem table cannot be misread.
    installScripts: 0,
    installScriptsPossible: false,
    groups: groups.size,
    medianAgeDaysByDepth: ageByDepth,
    medianAgeDays: Math.round(median(ages.map((x) => x.days)) ?? 0),
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
    console.error(`${key} → ${row.packages} pkgs, depth ${row.depth}, groups ${row.groups}, unresolved ${row.unresolved} (${row.ms}ms)`);
  }
}
writeStatus(state, "ГОТОВО");
console.error("done");
