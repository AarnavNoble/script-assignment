# Load test

**Setup.** Real time (no scaling). One `next start` process (Next.js 15, Node v20.20.1) with a 20-connection pg pool, Postgres 16 in Docker (max_connections 300), the load generator in a separate Node process (keep-alive HTTP), all on one 10-core laptop. Table: 1,600,000 scripts (16 languages x 100,000; approved 521,136, available 992,000, submitted 86,864), 300,000 contributors (80% in en/es/hi/pt). 1x = today's traffic: 1 claim/s, sessions lognormal (median 5 min, sigma 0.5, mean 5.67 min), heartbeat every 30 s, release at the end (no upload/submit; release is the same single-row UPDATE + audit insert as submit, and uploads go to MinIO, not Postgres). Open-loop Poisson arrivals at level x 1 claim/s; each level starts in steady state (level x 340 live leases written directly into the table, length-biased remaining lifetimes, random heartbeat phase), then 15 s warm-up (discarded) and 60 s measured (120 s at 1x). Latency is client-side, request start to last byte. "Error" = timeout (10 s), connection error or 5xx. Postgres-side: `pg_stat_activity` sampled every 200 ms (connections active / idle in transaction / waiting on locks), `pg_stat_database` commits per second, and the claim's pick statement and revive statement timed with `EXPLAIN ANALYZE` (in a rolled-back transaction, for a probe contributor) every ~2 s during the level. pg_stat_statements isn't loaded in this container, so that is the DB-side measure. CPU: `ps` for the Node server (100% = one core), `docker stats` for Postgres.

| Scenario | Target claims/s | Live leases | Achieved claims/s | Heartbeats/s | Claim p50 / p95 / p99 (ms) | Heartbeat p50 / p95 / p99 (ms) | Release p95 | Errors | Node CPU % | Postgres CPU % | PG conns active / idle-in-tx (pool) | Lock waits | Commits/s | DB pick / revive exec (ms, median) | Client loop p99 (ms) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1x | 1 | 340 | 1.0 | 10.9 | 11.2 / **23.8** / 36.0 | 7.9 / 16.5 / 25.3 | 14.6 | 0 | 7 | 6 | 0.0 / 0.0 (20) | 0.00 | 19 | 0.43 / 0.05 | 13 |
| 10x | 10 | 3,399 | 9.3 | 107.6 | 7.4 / **15.9** / 30.0 | 4.7 / 10.5 / 16.2 | 9.5 | 0 | 27 | 12 | 0.1 / 0.3 (20) | 0.00 | 134 | 0.69 / 0.04 | 13 |
| 100x | 100 | 33,994 | 91.0 | 988.6 | 68.8 / **5099.3** / 5269.8 | 48.6 / 5090.7 / 5256.8 | 5092.9 | 21 (0.03%) | 96 | 92 | 1.5 / 9.9 (20) | 0.00 | 1178 | 1.87 / 0.05 | 13 |
| 32x | 32 | 10,878 | 31.7 | 345.5 | 5.9 / **11.2** / 29.2 | 3.3 / 7.8 / 18.9 | 7.3 | 0 | 38 | 25 | 0.3 / 0.8 (20) | 0.00 | 415 | 1.03 / 0.04 | 12 |
| 57x | 57 | 19,377 | 56.8 | 616.9 | 5.9 / **19.3** / 57.7 | 3.3 / 12.3 / 32.5 | 11.3 | 0 | 63 | 42 | 0.5 / 1.5 (20) | 0.00 | 747 | 1.51 / 0.03 | 12 |
| 75x | 75 | 25,496 | 74.8 | 806.6 | 7.8 / **1111.5** / 1423.1 | 4.9 / 1125.3 / 1397.3 | 1108.6 | 0 | 80 | 66 | 1.1 / 4.7 (20) | 0.00 | 966 | 1.72 / 0.04 | 13 |
| 75x pool50 | 75 | 25,496 | 75.1 | 810.5 | 6.8 / **37.0** / 198.0 | 3.9 / 29.1 / 160.7 | 25.8 | 13 (0.02%) | 72 | 61 | 1.0 / 3.5 (50) | 0.00 | 964 | 1.69 / 0.04 | 11 |
| 1x hot-en | 1 | 340 | 1.0 | 10.2 | 11.3 / **24.7** / 38.9 | 7.9 / 18.4 / 25.9 | 16.2 | 0 | 7 | 5 | 0.0 / 0.0 (20) | 0.00 | 19 | 0.62 / 0.04 | 13 |
| 10x hot-en | 10 | 3,399 | 10.5 | 108.2 | 7.6 / **22.4** / 168.7 | 4.1 / 13.2 / 86.6 | 17.0 | 0 | 25 | 14 | 0.2 / 0.4 (20) | 0.00 | 136 | 1.79 / 0.04 | 12 |
| 57x hot-en | 57 | 19,377 | 56.5 | 614.8 | 8.9 / **30.8** / 103.8 | 3.5 / 21.9 / 80.1 | 14.8 | 0 | 61 | 60 | 0.6 / 1.9 (20) | 0.00 | 733 | 4.65 / 0.03 | 11 |

**Knee.** **One Postgres + one Node process handles ~57 claims/s (57x today's traffic, plus 617 heartbeats/s) with claim p95 19.3 ms**; at 75 claims/s p95 is 1111.5 ms. This is a laptop: Node, Postgres (in a Docker VM) and the load generator share 10 cores with whatever else is running.

**Where the bottleneck is.** Not Postgres's execution capacity: even at 75 claims/s only 1.1 backends were executing a statement on average, and the claim's pick statement took 1.72 ms inside Postgres. What runs out is the pg pool, because of how long each transaction holds its connection: a claim is ~7 round trips (BEGIN, contributor, resume, revive, pick, audit insert, COMMIT) and every round trip waits for a turn of the single Node event loop. As Node gets busy (63% of one core at 57/s, 80% at 75/s, 96% at 100/s), connections sit "idle in transaction" (1.5 on average at 57/s, 4.7 at 75/s), bursts exhaust the 20 connections, and requests queue: at 75/s the median claim is still 7.8 ms but p95 is 1111.5 ms (bimodal: fast, or queued behind the pool).

Raising the pool to 50 connections at the same 75 claims/s brought claim p95 from 1111.5 to 37.0 ms (p99 198.0 ms), with 13 requests that got no HTTP response or a 5xx (0.023%). So the first limit is pool size vs. Node turnaround; the next is the Node process itself, near one full core at 100/s (96%). Postgres used 66% of a core at 75/s (966 commits/s: every heartbeat is an UPDATE plus an audit insert). One run per level, so the exact knee position (between 57 and 75) carries run-to-run noise.

**What scales next.** Before Postgres: more Node processes and a bigger pool, or fewer round trips per claim (one SQL function instead of ~7 statements). The DB-side pick cost grows with the number of live leases in the language, because lowest-id order scans past them in the `scripts_free` index (0.43 ms at 1x vs 1.87 ms at 100x under load; see EXPLAIN below). Heartbeats are ~92% of requests; at 100x that is ~1,000 writes/s plus audit rows, the first thing to move off the primary (e.g. to Redis) if traffic ever gets there. Today's traffic (1x) uses 7% of a core for Node and 6% for Postgres.

**Hot language (all claims in en).** Claim p95 24.7 ms at 1/s, 22.4 ms at 10/s, 30.8 ms at 57/s, vs 23.8 ms, 15.9 ms, 19.3 ms with claims spread over 16 languages. No errors, and essentially no lock waits (0.00, 0.00, 0.00 sessions waiting on a lock on average). What does grow is the pick statement (0.62 ms, 1.79 ms, 4.65 ms), because all live leases are now in the one language the index scan walks.

## Hot language: SKIP LOCKED vs plain FOR UPDATE

Direct SQL (no HTTP), all claimers in `en`, K concurrent closed-loop claimers for 15 s each: the claim's pick+update in its own transaction, then the row is put back (so everyone keeps competing for the lowest ids). `for_update` is a throwaway copy of the query with `SKIP LOCKED` removed (lib/ untouched).

| Variant | Concurrent claimers | Claims/s | p50 (ms) | p95 (ms) | p99 (ms) |
|---|---|---|---|---|---|
| skip_locked | 1 | 559 | 1.15 | 1.81 | 3.88 |
| skip_locked | 4 | 1923 | 1.26 | 2.14 | 3.48 |
| skip_locked | 16 | 3085 | 2.94 | 5.51 | 8.85 |
| skip_locked | 32 | 4142 | 4.44 | 7.88 | 11.88 |
| for_update | 1 | 415 | 1.27 | 2.96 | 7.66 |
| for_update | 4 | 1528 | 1.41 | 2.89 | 5.65 |
| for_update | 16 | 1670 | 4.09 | 17.89 | 35.07 |
| for_update | 32 | 1836 | 5.60 | 43.31 | 95.71 |

**Interpretation.** With SKIP LOCKED, claims scale with concurrency (559/s with 1 claimer, 4142/s with 32) and p95 stays at 7.9 ms. Without it, claimers queue on the same lowest row; each waiter re-checks the row after the holder commits and moves on to the next one, so throughput flattens (1836/s at 32) and the tail grows (p95 43.3 ms, p99 95.7 ms vs 11.9 ms). Both rates are far above what the HTTP path reaches (the Node process limits it first), so in the HTTP test SKIP LOCKED shows up only as the flat hot-language latency above.

## EXPLAIN (ANALYZE, BUFFERS)

Full plans: [loadtest_explain.txt](loadtest_explain.txt) (current lib/, fresh_first v3) and [loadtest_explain_v2.txt](loadtest_explain_v2.txt) (the build the load test ran on, fresh_first v2). The SQL is read from lib/assign.ts at run time, so it is exactly what ships. Execution time (ms) for a probe contributor in `en`:

| Code | Table state | claim pick (lowest_id; v3 fallback) | claim pick (fresh_first) | revive own expired lease | resume live lease |
|---|---|---|---|---|---|
| fresh_first v2 | at rest, 0 live leases | 0.499 | 37.619 (one sorted query) | 0.044 | 0.009 |
| fresh_first v2 | 33,994 live leases, all in en (100x lease count in one language, worst case) | 8.463 | 32.333 (one sorted query) | 0.038 | 0.019 |
| fresh_first v3 (current) | at rest, 0 live leases | 1.221 | 0.090 (scripts_fresh) | 0.033 | 0.007 |
| fresh_first v3 (current) | 33,994 live leases, all in en (100x lease count in one language, worst case) | 5.459 | 0.125 (scripts_fresh) | 0.021 | 0.006 |

**Indexes used.** The lowest_id pick is an `Index Scan using scripts_free` (`(language, id) WHERE status IN ('available','claimed')`) under `LIMIT 1 ... FOR UPDATE SKIP LOCKED`: it reads the language's free rows in id order and stops at the first unlocked match (0.50 ms at rest). Its cost is proportional to the live leases ahead of the first free row: with 33,994 live leases in the probed language it filters out all of them (8.46 ms, ~4,700 buffers). Spread over 16 languages at 100x, roughly a quarter of that lands in each popular language, consistent with the ~2 ms measured under load. Resume uses `one_claim_per_contributor` (0.009 ms); revive uses a BitmapOr of `one_claim_per_contributor` and `scripts_prev_token` (0.044 ms; it reads every row that has a prev_token, since there is no index on `prev_claimed_by`, so its cost grows with released or expired rows nobody has re-claimed).

**fresh_first v2 (the build this load test ran on) did not use the index order.** `ORDER BY (status <> 'available' OR prev_token IS NOT NULL), id` is an expression, so Postgres bitmap-scans every free row of the language (62,000 for en here) and sorts them, spilling to disk (`Sort Method: external merge`) because they exceed work_mem: 37.6 ms per claim at rest vs 0.50 ms for lowest_id. At 1x that is invisible; at the measured knee (~57 claims/s) it would be ~2.1 s of Postgres time per second. **Fixed in v3 (current lib/):** a partial index `scripts_fresh (language, id) WHERE status = 'available' AND prev_token IS NULL` is tried first with `LIMIT 1 ... SKIP LOCKED`, and the lowest_id query is the fallback. Re-measured on a freshly seeded 16 x 100k table: the fresh pick takes 0.090 ms at rest and 0.125 ms with the worst-case live leases (it never visits claimed rows), the fallback 1.221 / 5.459 ms. The HTTP load levels above ran with lowest_id, so they are unaffected.
