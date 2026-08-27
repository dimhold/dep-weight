# dep-weight

[![DOI](https://zenodo.org/badge/DOI/10.5281/zenodo.22128854.svg)](https://doi.org/10.5281/zenodo.22128854)

What a dependency tree actually costs, measured from registry metadata across
three ecosystems: **npm, PyPI and Maven Central**.

Nothing is installed. Every number comes from the registries' own JSON and XML,
which means the whole study reruns on a laptop in about a minute and the raw rows
in [`results/`](results/) can be re-derived by anyone who disagrees with a
definition.

**1,050 resolutions** — 14 stacks × 25 monthly snapshots × 3 ecosystems.

## Why not `npm install`

Installing measures one day. Reading the registry lets you resolve the *same
manifest as of any past date*, which is the only way to answer the question this
started from: **how much does a dependency tree change while the file describing
it does not?**

It also makes the study cheap enough to be honest. No 300 MB `node_modules` per
data point, no disk pressure, no reason to cut the sample down.

## What it found

### 1. The trees are not growing. Most of them shrank.

Every dependency post opens with "trees keep inflating". Resolved month by month
with the manifest frozen, the mainstream stacks went the other way over two years:

| stack | packages 2024-08 → 2026-08 | publishing accounts |
|---|---|---|
| express + cors + body-parser | 80 → **71** | 20 → **16** |
| webpack | 78 → **68** | 35 → **26** |
| spring-boot-starter-data-jpa | 65 → **54** | n/a |
| spring-boot-starter-security | 35 → **28** | n/a |
| okhttp | 12 → **5** | n/a |
| eslint | 89 → 86 | 35 → 33 |
| axios | 9 → **30** | 7 → 10 |
| micronaut-http-server-netty | 42 → **66** | n/a |

Across all three ecosystems, most stacks held flat or shrank. The ones that grew
(axios, micronaut, transformers) are named rather than hidden.

The second column is the one nobody prints: on npm, **the number of human accounts
able to push code into your build fell faster than the package count**.

### 2. Same job, three ecosystems, two orders of magnitude

| job | npm | PyPI | Maven |
|---|---|---|---|
| web framework | 71 | **8** | 37 |
| ORM + driver | 79 | **4** | 54 |
| test runner | **259** | 5 | 9 |
| http client | 30 | 7 | 5 |

`jest` resolves to 259 packages. `pytest` does the same job in 5. This is not a
language difference — it is a packaging culture difference, and it is 50×.

### 3. The deeper the package, the older the code

Median days since a package last published, by its depth in the tree:

| depth | npm | PyPI | Maven |
|---|---|---|---|
| 1 (what you typed) | 36 | 77 | **17** |
| 2 | 468 | **48** | 70 |
| 3 | 671 | 622 | 341 |
| 4 | 1,251 | **92** | 308 |
| 5 | **1,846** | 103 | 1,329 |
| 8 | 4,057 | – | **6,855** |

npm and Maven show the same gradient: you install something released last month
and four levels down you are running code last touched three to five years ago. On
Maven the tail is worse — depth 8 sits at nearly 19 years.

**PyPI does not do this.** Its deep packages are about as fresh as its shallow
ones. Whatever Python's packaging is criticised for, its transitive layer is
maintained.

### 4. `npm install` runs code from people you never chose

A package can execute its own code during install (`preinstall`, `install`,
`postinstall`, `prepare`). Counting those, and the distinct accounts that
published them:

| stack | packages | install scripts | distinct accounts |
|---|---|---|---|
| jest | 259 | **14** | **11** |
| eslint | 86 | 10 | 6 |
| typeorm + pg | 79 | 8 | 6 |
| webpack | 68 | 6 | 4 |
| express + cors + body-parser | 71 | 2 | 1 |

`npm i jest` runs install-time code belonging to eleven separate accounts, almost
all of them three or four hops from anything you named.

The cross-ecosystem row matters more than the table: **on Maven this number cannot
exist.** Resolving a dependency never executes its code. On PyPI it is bounded —
in these 14 stacks, zero packages resolved to a source-only distribution.

### 5. The metric everyone quotes explains the least

From the one run that did touch disk ([`npm-scan.mjs`](npm-scan.mjs)):
`next@15` → **21 packages, 311 MB**. `express@5` → **66 packages, 2.2 MB**.
`@prisma/client` → **1 package, 77 MB**. Three orders of magnitude of weight
across the same range of counts.

## Reproducing

```bash
npm install                 # one dependency: semver
node registry-scan.mjs      # npm     → results/npm.ndjson
node pypi-scan.mjs          # PyPI    → results/pypi.ndjson
node maven-scan.mjs         # Maven   → results/maven.ndjson
node report.mjs             # rebuilds every table above from those files
```

Each scanner is resumable and safe to leave unattended: state is written after
every unit of work, `touch PAUSE` stops it cleanly at the next one, a disk floor
stops it before filling the volume, and `STATUS-*.md` says where it got to without
reading any code. The runs in [`logs/`](logs/) are the real ones, unedited.

## What this does not say

- This is the **logical** graph: every distinct package@version reachable from the
  manifest. Installers hoist and dedupe on disk, which changes layout and install
  size, not the set of code you end up trusting.
- Runtime dependencies only. npm devDependencies, PyPI extras, Maven `test` and
  `provided` scopes are excluded. That is why prisma, angular, next and quarkus
  look small: their weight arrives bundled, as peers, or through a BOM.
- "As of date X" means a fresh resolution with no lockfile. A lockfile is exactly
  what freezes the drift in finding 1, which is the practical takeaway rather than
  a limitation of the method.
- The Maven resolver implements parent POMs, property interpolation,
  `dependencyManagement` and imported BOMs, scope and optional filtering. It does
  not implement profiles, exclusions or relocation, each of which would shrink a
  real tree slightly, so Maven counts here are an upper bound.
- PyPI markers are evaluated for Python 3.12 on Linux; extras are never followed.
- PyPI publishes no per-version publisher account and Maven Central publishes only
  prose in `<developers>`, so the "who can push code into your build" count exists
  for npm alone. That absence is a result, not a gap in the code.
- 14 stacks per ecosystem, one registry each, one day of measurement. A comparison,
  not a benchmark.

MIT.

## Prior work

Checked 2026-08-27. Every neighboring question has an owner. The three
headline measurements do not, as far as I could find.

- Comparing dependency networks across ecosystems is a settled genre.
  [Decan, Mens and Grosjean (2019)](https://doi.org/10.1007/s10664-017-9589-y)
  compared the evolution of seven packaging ecosystems from Libraries.io data.
  [deps.dev](https://deps.dev/) publishes resolved dependency graphs for six
  ecosystems, [Ecosyste.ms](https://ecosyste.ms/) maintains continuously
  updated registry metadata and this repository's counts are validated against
  deps.dev in [VALIDATION.md](VALIDATION.md).
- Historical resolution is taken for npm.
  [npm-follower](https://doi.org/10.1145/3611643.3613094) archives every npm
  version as published and the same group built a
  [time travelling dependency resolver](https://arxiv.org/abs/2304.00394) to
  study how semver updates flow. Their question is different but resolving npm
  manifests as of past dates is already done. I found no equivalent for PyPI
  or Maven Central.
- Trust through the tree is measured for npm.
  [Zimmermann et al. (2019)](https://www.usenix.org/conference/usenixsecurity19/presentation/zimmerman)
  counted the packages and maintainers an install implicitly trusts,
  [Zahan et al. (2022)](https://arxiv.org/abs/2112.10165) flagged install
  scripts and maintainer reach as weak links and
  [Duan et al. (2021)](https://www.ndss-symposium.org/ndss-paper/towards-measuring-supply-chain-attacks-on-package-managers-for-interpreted-languages/)
  compared install time attack surface across npm, PyPI and RubyGems.
- Outdatedness has its own literature under the name technical lag:
  [Decan, Mens and Constantinou (2018)](https://doi.org/10.1109/ICSME.2018.00050)
  for npm and [Kula et al. (2017)](https://doi.org/10.1007/s10664-017-9521-5)
  on whether developers update at all.
  [Soto-Valero et al. (2021)](https://doi.org/10.1007/s10664-020-09914-8)
  measured bloated dependencies in Maven.

What was not found anywhere: the same manifest resolved month by month across
three ecosystems at once, the count of accounts able to publish into a named
application's tree tracked over time and package age broken down by depth in
the resolved tree. Searched Crossref, dblp, Semantic Scholar, arXiv, GitHub
and the general web.
