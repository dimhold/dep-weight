# Validation against deps.dev — 2026-08-19

Our resolver checked against **Google's Open Source Insights** (`api.deps.dev`),
which publishes already-resolved dependency graphs for npm, PyPI and Maven.
Script: [validate-depsdev.mjs](validate-depsdev.mjs). Raw output:
[validation.json](validation.json).

The point was never to agree. It was to find out *where* we disagree and why,
before any of these numbers goes into a post.

## Headline

**29 single-root stacks compared. 14 match exactly, 23 within two packages.**

That is after correcting one definitional gap that the first run exposed.

## What the first run caught

The raw comparison showed our counts running **+1 higher almost everywhere**:
vue 23 vs 22, svelte 20 vs 19, webpack 68 vs 67, axios 30 vs 29, django 3 vs 2,
pytest 5 vs 4, jackson 3 vs 2, junit5 9 vs 8, okhttp 5 vs 4, kafka 5 vs 4.

Ten stacks off by exactly one is not noise, it is a definition. **We count the
root package as a node in the tree; deps.dev reports the graph without SELF.**
Neither is wrong, but a number is meaningless until you say which one you meant.
The comparison now subtracts the roots, and `validation.json` keeps `rawDelta`
beside `delta` so the gap stays visible instead of being tidied away.

Worth stating plainly: **that +1 is in every package count published in
[RESULTS.md](RESULTS.md) and in the repo README.** "express resolves to 71
packages" means 70 dependencies plus express itself.

## The outliers, and what each one is

| stack | ours | deps.dev | diff | explanation |
|---|---|---|---|---|
| log4j-core | 2 | 14 | **-13** | log4j-core's POM marks **15 dependencies optional**. We skip optional; deps.dev includes them. Verified by counting `<optional>true</optional>` in the POM. |
| netty-all | 143 | 0 | **+142** | Their default version reports an empty graph while the POM we read lists 338 dependency entries with zero optional flags. **Unexplained. Do not use netty in any published claim until this is understood.** |
| jest | 259 | 323 | -64 | They find more, consistent with including optional and platform-specific edges we drop. |
| eslint | 86 | 68 | +18 | We find more. Not yet explained. |
| httpx | 7 | 1 | +5 | PyPI extras: httpx's core deps are declared in a way we follow and they do not. |
| vertx-web | 33 | 24 | +8 | Maven optional/provided boundary again, in the other direction. |

Everything else lands within two.

## What this does and does not license

**Safe to publish**, because the counts agree with an independent resolver on
23 of 29 stacks and the disagreements are named:

- the drift finding (same manifest, resolved month by month)
- the age-by-depth gradient
- the publisher-account counts, which deps.dev does not compute at all
- the cross-ecosystem comparison, with the caveat below

**Not safe to publish as-is:**

- any claim resting on **netty**, until the empty graph is explained
- any exact package count presented without saying whether the root is included
- the log4j and eslint rows, until the optional-dependency boundary is stated in
  the same sentence as the number

## The uncomfortable part

deps.dev already publishes resolved dependency graphs for six ecosystems. So
"nobody has counted how many packages express pulls in" is **false**, and no post
from this study should imply it. What deps.dev does not publish is the thing this
study is actually about: **the same manifest resolved as of past dates**, and the
count of human accounts able to publish into a tree. Those stay ours.
