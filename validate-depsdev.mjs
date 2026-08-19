/**
 * Check our resolver against Google's deps.dev, which publishes already-resolved
 * dependency graphs for npm, PyPI and Maven.
 *
 * The point is not to agree. It is to find out *where* we disagree and why,
 * before any number from this study goes into a post. A resolver that nobody
 * checked is an opinion with a JSON file attached.
 *
 * Two known reasons the counts should differ, both expected rather than bugs:
 *   - deps.dev resolves the graph the ecosystem's own installer would produce,
 *     including bundled and platform-specific edges we skip.
 *   - we walk runtime dependencies only, and skip nothing else; extras, dev and
 *     test scopes are out on both sides but the boundary is drawn differently.
 *
 * Anything beyond that is ours to explain. Output: validation.json plus a table.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CACHE = join(HERE, "cache-depsdev");
mkdirSync(CACHE, { recursive: true });

/** One representative root per stack: the package the stack is named after. */
const ROOTS = {
  npm: {
    "express-api": "express",
    fastify: "fastify",
    nestjs: "@nestjs/core",
    next: "next",
    "vite-react": "vite",
    angular: "@angular/core",
    vue: "vue",
    svelte: "svelte",
    prisma: "@prisma/client",
    typeorm: "typeorm",
    jest: "jest",
    eslint: "eslint",
    webpack: "webpack",
    axios: "axios",
  },
  pypi: {
    flask: "flask",
    django: "django",
    fastapi: "fastapi",
    requests: "requests",
    pandas: "pandas",
    sqlalchemy: "sqlalchemy",
    pytest: "pytest",
    celery: "celery",
    boto3: "boto3",
    "scikit-learn": "scikit-learn",
    transformers: "transformers",
    langchain: "langchain",
    poetry: "poetry",
    httpx: "httpx",
  },
  maven: {
    "spring-boot-web": "org.springframework.boot:spring-boot-starter-web",
    "spring-boot-data-jpa": "org.springframework.boot:spring-boot-starter-data-jpa",
    "spring-boot-security": "org.springframework.boot:spring-boot-starter-security",
    micronaut: "io.micronaut:micronaut-http-server-netty",
    vertx: "io.vertx:vertx-web",
    jackson: "com.fasterxml.jackson.core:jackson-databind",
    hibernate: "org.hibernate.orm:hibernate-core",
    junit5: "org.junit.jupiter:junit-jupiter",
    okhttp: "com.squareup.okhttp3:okhttp",
    guava: "com.google.guava:guava",
    kafka: "org.apache.kafka:kafka-clients",
    netty: "io.netty:netty-all",
    log4j: "org.apache.logging.log4j:log4j-core",
    quarkus: "io.quarkus:quarkus-resteasy-reactive",
  },
};

const SYSTEM = { npm: "npm", pypi: "pypi", maven: "maven" };
const enc = (s) => encodeURIComponent(s);

async function api(path, key) {
  const file = join(CACHE, enc(key) + ".json");
  if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8"));
  for (let a = 0; a < 4; a++) {
    try {
      const res = await fetch(`https://api.deps.dev/v3/${path}`);
      if (res.status === 404) { writeFileSync(file, JSON.stringify({ missing: true })); return { missing: true }; }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      writeFileSync(file, JSON.stringify(json));
      return json;
    } catch (e) {
      if (a === 3) return { failed: String(e).slice(0, 120) };
      await new Promise((r) => setTimeout(r, 500 * 2 ** a));
    }
  }
}

/** Their default version, so we compare like for like rather than picking our own. */
async function defaultVersion(system, name) {
  const pkg = await api(`systems/${system}/packages/${enc(name)}`, `pkg|${system}|${name}`);
  if (!pkg?.versions?.length) return null;
  const def = pkg.versions.find((v) => v.isDefault);
  return (def ?? pkg.versions.at(-1)).versionKey.version;
}

async function graphSize(system, name, version) {
  const g = await api(
    `systems/${system}/packages/${enc(name)}/versions/${enc(version)}:dependencies`,
    `dep|${system}|${name}|${version}`
  );
  if (!g?.nodes) return null;
  // node 0 is SELF; count the rest, and separately the ones they mark bundled.
  const deps = g.nodes.slice(1);
  return {
    total: deps.length,
    bundled: deps.filter((n) => n.bundled).length,
    direct: (g.edges ?? []).filter((e) => e.fromNode === 0).length,
    version,
  };
}

const ours = {};
for (const [eco, file] of [["npm", "results.ndjson"], ["pypi", "results-pypi.ndjson"], ["maven", "results-maven.ndjson"]]) {
  const rows = readFileSync(join(HERE, file), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const last = rows.map((r) => r.asOf).sort().at(-1);
  ours[eco] = Object.fromEntries(rows.filter((r) => r.asOf === last).map((r) => [r.stack, r]));
}

const out = [];
for (const [eco, roots] of Object.entries(ROOTS)) {
  for (const [stack, name] of Object.entries(roots)) {
    const mine = ours[eco]?.[stack];
    if (!mine) continue;
    const version = await defaultVersion(SYSTEM[eco], name);
    const theirs = version ? await graphSize(SYSTEM[eco], name, version) : null;
    out.push({
      ecosystem: eco,
      stack,
      root: name,
      theirVersion: version,
      ours: mine.packages,
      theirs: theirs?.total ?? null,
      theirsBundled: theirs?.bundled ?? null,
      // Our stacks sometimes list more than one root, so a diff is only meaningful
      // where the stack is a single package. Flagged rather than silently compared.
      singleRoot: mine.direct === 1,
      // We count the roots as nodes; deps.dev reports the graph without SELF. So a
      // like-for-like diff subtracts the roots before comparing, and the raw delta
      // is kept beside it so the definitional gap stays visible rather than tidied.
      rawDelta: theirs ? mine.packages - theirs.total : null,
      delta: theirs ? mine.packages - mine.direct - theirs.total : null,
    });
    await new Promise((r) => setTimeout(r, 120));
  }
}

writeFileSync(join(HERE, "validation.json"), JSON.stringify({ date: new Date().toISOString().slice(0, 10), rows: out }, null, 1));

const pad = (s, n) => String(s).padEnd(n);
const num = (s, n) => String(s ?? "-").padStart(n);
console.log(`${pad("eco", 7)}${pad("stack", 22)}${num("ours", 6)}${num("deps.dev", 10)}${num("delta", 7)}  root`);
for (const r of out) {
  const mark = r.singleRoot ? "" : "  (multi-root)";
  console.log(pad(r.ecosystem, 7) + pad(r.stack, 22) + num(r.ours, 6) + num(r.theirs, 10) + num(r.delta, 7) + "  " + r.root + mark);
}

const comparable = out.filter((r) => r.singleRoot && r.theirs != null);
const exact = comparable.filter((r) => r.delta === 0).length;
const close = comparable.filter((r) => Math.abs(r.delta) <= 2).length;
console.log(`\nsingle-root stacks compared: ${comparable.length}`);
console.log(`exact match: ${exact}   within 2: ${close}`);
