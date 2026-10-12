# Indexed file matching validation

Baseline: `8a0c428edb9f8439e5138261047d2d0e3b3a4b78` (v7 master). Node 26 is
required. This patch changes file comparisons and their use in
`assessCandidate`.

## Review follow-up

The call path is `pipeline.assessCandidates` → `assessCandidateCaching` →
`assessCandidate`. Exact membership runs first, then consuming size/name
matching. Partial mode can then run size membership and consuming whole-piece
matching. Previously these stages built up to four indexes per assessment.

The revised implementation builds a lazy immutable index once per assessment.
Unique sizes store source offsets. Tied groups of up to eight files store offset
arrays; larger groups use name-count maps and optional path membership sets to
bound comparison work. Each consuming pass owns independent typed counters.
Exact membership remains non-consuming; the last available file of a size can
match a different name. NaN never matches, signed zero matches, and infinities
retain the baseline arithmetic. Public helper signatures are unchanged.
Standalone `getPartialSizeRatio` builds its size set in one loop.

First-file probes reject missing sizes or paths before index allocation. In
strict/flexible mode, one shared scan for an absent first size proves both full
matchers fail and returns the same size-mismatch assessment. Small assessments
call the original array bodies directly, without creating an index context. The
128-file threshold keeps the array matcher for small releases; the measurement
section records evidence and limitations for this choice.

## Reproduction

Use separate baseline and candidate checkouts with identical lockfiles and
Node 26. Install dependencies in independent fresh checkouts, then
`npm run build` in both. Existing local dependency links were reused without
reinstalling or modifying the lockfile in this run. Keep raw output outside the
source tree:

```sh
node docs/audit/patch03/validate.mjs ../baseline . > /path/to/correctness.json
node --expose-gc docs/audit/patch03/benchmark.mjs ../baseline . /path/to/helpers.json
node --expose-gc docs/audit/patch03/assessment-benchmark.mjs ../baseline . /path/to/assessments.json
```

`validate.mjs` imports actual compiled exports. It performs 120,120 helper
comparisons over three fixed seeds and 4,644 additional assessments, comparing
decisions, returned keys, cache flags and original-metafile identity. Fixtures
include subsets, permutations, duplicate consumption, changed names/paths,
virtual/data/client sources, NaN, signed zero, infinities and whole-piece math.
Counts include the 127/128/129 threshold boundary. The 144 explicit finite
assessment cases independently assert exact, size-only and partial successes and
rejections across all matching modes; decision coverage by mode and threshold
band is retained separately from randomized numeric-edge cases.

`benchmark.mjs` retains 20 fresh-process A/B/A cycles for four isolated helpers,
unique/tied sizes, success and first/last rejection, plus three allocation
cycles. `assessment-benchmark.mjs` runs 12 fresh-process A/B/A cycles on the
full compiled `assessCandidate` with actual parsed Metafile instances. Seven
exact, renamed, strict rejection and partial outcomes exercise its real
branching, including four-stage partial assessments. It excludes torrent
download, cache I/O, tracker requests and injection; it is not whole-daemon
latency evidence.

The assessment harness reports explicitly synthetic success-heavy,
rejection-heavy and partial-heavy sensitivity models. Weighted values combine
case medians using stated weights; they are not measured production percentiles
or tracker frequencies. Cached successful decisions can survive the
already-injected fast path, which skips `assessCandidate`; a cached decision
histogram therefore cannot establish helper invocation frequencies. A1/A2 are
retained independently to expose drift. Inspector allocation sampling is
separate from timing, at a 4 KiB interval with collected objects included.
Sampled V8 allocation is an estimate; heap growth and array-buffer growth are
separate proxies. Peak RSS includes imported modules and fixtures, rather than
attributable comparison memory alone.

## Verification

The source-read regression failed the old candidate at 1,400 reads for a
200-file partial assessment, against a 600-read budget. The revised source
passes. Two strict/flexible assessment regressions failed the intermediate
source at 400 reads against a 200-read one-scan budget, then passed with
preserved decision, Metafile reference and cache flag. Another assessment test
catches consumption leaking from size-only matching into partial matching. The
existing 160-file mock tracker/client integration verifies injection and every
linked file's device/inode.

Full workspace tests (91 tests), typecheck, lint, formatting and build pass. The
compiled differential validator reports zero mismatches in all 124,764
comparisons. No private tracker calls or production mutation are part of this
validation. Measurements and final gate identities are recorded in the external
evidence bundle. Linux container, NFS and production distribution validation are
separate from the synthetic local results.

## Final measurements and limits

Local hardware: Apple M1 Pro, macOS arm64, Node 26.11.1. Full assessment
measurements use 12 A/B/A cycles; helper measurements use 20. Baseline values
below average the independent A1/A2 medians. Raw phase values, p95, allocation
samples and every negative result remain in the external evidence bundle.

| Unique-size assessment             | Baseline p50 | Candidate p50 |
| ---------------------------------- | -----------: | ------------: |
| 1-file exact                       |     0.617 µs |      0.622 µs |
| 20-file partial                    |     7.211 µs |      7.313 µs |
| 127-file partial                   |    28.425 µs |     28.330 µs |
| 128-file partial                   |    28.377 µs |     10.790 µs |
| 1,000-file early strict rejection  |    10.217 µs |      5.617 µs |
| 10,000-file early strict rejection |    89.750 µs |     42.041 µs |
| 10,000-file exact success          |   182.337 ms |      1.016 ms |
| 10,000-file partial success        |   191.315 ms |      1.032 ms |

The 128-file threshold is retained: both size distributions improve across all
three weighted sensitivity scenarios at 128 files (42–73%), while 127-file
assessments use the baseline routines directly. At 1,000 files these scenarios
improve 84–94%; at 10,000 files they improve 98.2–99.5%. Below 128 files the
weighted changes range from a 1.1% improvement to a 10.5% regression. The latter
is a tied 20-file rejection-heavy scenario; these models are explicitly
hypothetical frequencies, not production throughput or CPU savings.

**The relative 5% regression gate is not a clean pass.** There are 37 local
helper/assessment cases exceeding it at p50 or p95, retained in
`regressions-final.json`. The standalone unique 10,000-file early size/name
helper rises 38.749→166.000 µs (+328%); the unique 1,000-file early exact helper
rises 3.969→14.617 µs. Full strict/flexible assessments can bypass these helpers
with the shared absent-size proof, which explains the different pipeline result.
No claim that all individual helpers improve is warranted.

The controller also measured the same frozen compiled assessment on native Node
26/Linux amd64 on TrueNAS (AMD Ryzen 5700G), with five A/B/A timing cycles. The
unique 1,000-file early rejection regresses: A1/B/A2 are 13.89/25.39/17.99 µs, a
9.45 µs addition versus the mean baseline medians. The 10,000-file early
rejection improves 132.07/72.30/129.68 µs; exact success is 183.55/1.38/186.63
ms. Native 20-/127-file partial medians are 9.72/9.90/9.71 and 40.64/40.72/40.73
µs respectively. These are synthetic compiled assessments on actual hardware,
rather than live tracker invocations.

At 10,000 unique files, full exact sampled V8 allocation is approximately
1.003→0.947 MB; full partial is 3.456→1.745 MB plus 80 KB of measured
typed-buffer backing storage. Tied full partial falls 6.488→1.634 MB plus 80 KB
buffers, but tied exact rises 0.916→1.766 MB. The compact representation reduces
the earlier 4.05 MB tied-exact allocation; the residual increase remains a
tradeoff. Sampling is an estimate and the buffer-growth proxy is not total
lifetime allocation.

A read-only cache snapshot contains 8,194 client searchees, 8,134 (99.27%) below
128 files. This supports preserving their original algorithm, but does not
establish invocation frequency, joint outcome/file-count distribution, or
whole-daemon improvement. The recommendation is conditional: large matching
workloads improve substantially, with documented standalone-helper, native early
rejection and allocation costs. Initial negative matrices and both tuning pilots
are retained alongside the final results; no production change is implied.

## External evidence and clean CI

Raw captures and rejected pilots are excluded from the source diff and branch
history. The
[checksummed benchmark release](https://github.com/venku122/cross-seed/releases/tag/benchmark-evidence-2026-10-11)
is linked from the PR description, with separate original and review-follow-up
assets. Fresh fork Linux Node26 and Windows tarball workflows use clean
checkouts without a precreated CONFIG_DIR. Docker publication requires the
upstream repository identity.
