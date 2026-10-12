# Bounded full-client cache reads

Scope: qBittorrent, Transmission, Deluge and rTorrent full-client
`getClientSearchees`. Catalog requests, nonempty full snapshot deletion, daily
force-all cadence and database schema are preserved. Cache writes retain their
original order and 100-row batch size.

Pinned base: `8a0c428edb9f8439e5138261047d2d0e3b3a4b78`. Node 26.11.1 on macOS
arm64. Raw measurements live outside this checkout in
`next-audit/results/batching`.

The compiled baseline does one full cached-row SELECT per catalog entry. At
1,001 cached torrents, all four actual compiled adapters failed the batching
regression with 1,002 SELECTs (including the existing complete-snapshot hash
scan). The new reader uses at most 500 hashes per lightweight query and selects
full rows only for unchanged entries that must be returned. A 1 MiB
serialized-file budget subdivides hydration; a single torrent larger than the
budget is read alone. File JSON parsing still occurs only when returning a
cached searchee. Force-all and new-only paths omit both file size metadata and
cached file hydration.

Reproduce after building both baseline and candidate with the same Node runtime:

```sh
node scripts/performance/client-cache-batches.mjs . QBittorrent 1001 unchanged 4 assert-batched
node scripts/performance/run-client-cache-batches.mjs ../clean-baseline . ../results/batching/timing
```

The harness invokes actual compiled adapter methods, Knex and migrated SQLite.
Client catalog/RPC responses use synthetic transport adapters; their
payload-byte counter measures encoded synthetic responses, not production
network traffic. It runs the actual compiled Fastify `baseApiPlugin` on loopback
and verifies `/api/ping` responses while refreshing. No daemon, private client,
production database or filesystem fixture is accessed. Five independent A/B/A
rounds compare returned-object and cache-row digests plus request counts and
payload bytes. Cold-ish fixtures are freshly seeded local SQLite databases, not
dropped OS page caches. Warm fixtures perform one unchanged adapter call before
measurement.

The matrix covers catalogs of 0, 1, 100, 8,194, 20,000 and 30,000 torrents;
0/1/10 changed entries; explicit force-all, new-only and warm reads; 100
torrents with 100 or 1,000 files each and one torrent with 10,000 files.
Separate structural checks exercise new/removal, external failures, mixed case
and canonical hash aliases, moves, empty file results and multiple hosts. Real
SQLite regressions exercise concurrent metadata updates between lightweight
checks and hydration. The existing conservative empty-client behavior remains
unchanged: an empty catalog returns before complete-snapshot deletion.

All required local gates pass (71 workspace tests), with seven real SQLite
regressions and 60 compiled adapter differential cases. At 1,001 unchanged
records, cache SELECTs fall from 1,002 to 9; forced/new-only 100-record reads
fall from 101 to 2, with no cached file JSON parsing.

Frozen source aggregate:
`f5536f7e14bf1f7ecf544fc331b3caa025287a29e49c219cb58b64d7812268cf`. Frozen
compiled aggregate:
`d1debf0eff23ba0af00360ea478c19b1ddc70a113deb0813b204eccc529f194c`. Aggregates
cover adapters plus searchee, DB and utility modules.

Final exclusive matrix: 960 workers, 320 verified triplets, five A/B/A rounds,
11m17s. All output/cache digests, RPC counts/bytes, returned file counts and
file parse counts agree. Raw `timing-final/aba.jsonl` SHA256:
`213a381b7b5f0e0f04e13db7e47aa57025b5359190d0ec064626fbf0eb4fca14`.
`timing-final/summary.json` contains all 64 fixture distributions. Comparisons
below use each fixture's ten baseline and five candidate samples.

| Fixture across four clients        | Median wall change | Median CPU change |
| ---------------------------------- | ------------------ | ----------------- |
| 8,194–30,000 unchanged, four files | −59% to −65%       | −45% to −60%      |
| 8,194, one/ten changed             | −60% to −64%       | −45% to −50%      |
| 8,194 force-all                    | −55% to −60%       | −43% to −49%      |
| 8,194 new-only                     | −78% to −84%       | −61% to −80%      |
| Warm 8,194 unchanged               | −59% to −66%       | −54% to −60%      |
| 100 unchanged, 100 files           | −34% to −42%       | −34% to −41%      |
| 100 unchanged, 1,000 files         | +12% to +24%       | +45% to +94%      |
| One unchanged, four files          | +23% to +38%       | +26% to +38%      |

The 5% regression gate is **not a clean pass**. Besides the two consistently
slower fixture groups above, Transmission one-torrent/10,000-file reads regress
wall 6.6% and CPU 7.3%; its new-only case regresses wall 6.1% and CPU 10.3%.
Deluge's empty catalog regresses median wall 5.6% (1.31 to 1.38 ms). Tiny
single-row cache overhead is about 0.3–0.4 ms. The file-heavy group pays for
bounded transactional size rechecks and hydration; operation counts alone do not
predict this cost. No postmeasurement threshold tuning was performed.

Normal four-file cached reads transfer 30–32% more SQLite string bytes because
lightweight fields and hash/size metadata are read before full hydration.
Forced/new-only reads transfer 68–70% fewer bytes at 8,194;
100-torrent/1,000-file new-only reads transfer 99.8% fewer. These are returned
string bytes, not disk I/O measurements. At 8,194 unchanged, SELECTs fall 8,195
to 52, and full-row SELECTs 8,194 to 17; forced/new-only SELECTs fall to 18 with
no full-row reads. At 30,000 unchanged SELECTs fall 30,001 to 181.

Median ending/peak RSS at 8,194 unchanged improves 10–14%; 30,000 rTorrent
regresses 5.7%, with other clients increasing 2.3–2.6%. Peak RSS is process
lifetime high-water sampled immediately after the call, including startup and
fixture seeding; it is not an isolated allocation bound. Full returned objects
remain proportional to the catalog.

Median per-worker API ping p95 improves 86–96% for large unchanged catalogs, and
18–42% for 100-torrent/1,000-file hydration despite slower refreshes.
Single-torrent/four-file ping p95 regresses 9–36%; Transmission one-torrent/
10,000-file ping p95 regresses 8.4%. Baseline event-loop histograms often
contain only zero to two samples because synchronous refresh starves the
sampler; they cannot establish a reliable event-loop percentile improvement.
In-flight real `/api/ping` requests expose that stall. Candidate histograms have
more samples after bounded yields. Tiny-fixture ping samples are sparse too.

Tail regressions remain in the raw data: the observed candidate wall maxima
(nearest-rank p95/p99 with only five samples) are 2,271 ms versus 1,289 ms for
qBittorrent 30,000 unchanged; 872 ms versus 353 ms for Transmission 8,194
unchanged; and 1,543 ms versus 554 ms for rTorrent 8,194 force-all. Their median
improvements do not establish a clean tail-latency win. Baseline A1/A2 median
wall drift reaches 14.2% in a tiny 10,000-file singleton, and 9.8% for
qBittorrent 100-torrent/1,000-file hydration. All samples, including outliers,
are retained.

These results support fewer queries and faster large synthetic catalogs, with
explicit small-catalog, file-heavy, SQL-byte, RSS and tail tradeoffs. They do
not establish production speedups or universal memory improvement. The public
API still returns all requested searchees; client catalog arrays and the
existing full-snapshot hash list remain proportional to catalog size. Each
lightweight batch is capped at 500 rows and hydration file JSON at 1 MiB except
one individually oversized row. Tags and individual rows can be arbitrarily
large. Write serialization is bounded by the original 100-row batch, whose
individual rows can also be large. No schema or daily force-all cadence change
is included.
