use anyhow::{Context, Result};
use piw::source::RunSource;
use serde_json::json;
use std::path::PathBuf;
use std::time::Instant;

fn main() -> Result<()> {
    let mut args = std::env::args().skip(1);
    let database = PathBuf::from(
        args.next()
            .context("usage: refresh_benchmark DATABASE [TICKS]")?,
    );
    let ticks = args
        .next()
        .map(|value| value.parse::<u64>())
        .transpose()
        .context("TICKS must be an integer")?
        .unwrap_or(1_000);
    let database_bytes = std::fs::metadata(&database)?.len();
    let mut source = RunSource::new(&database)?;
    let run_count = source.ordered_run_ids().len();
    if let Some(run_id) = source.ordered_run_ids().first() {
        source.watch(run_id)?;
    }
    let started = Instant::now();
    let mut tick_histogram = vec![0_u64; 100_001];
    let mut max_tick_micros = 0_u128;
    for _ in 0..ticks {
        let tick_started = Instant::now();
        source.refresh_all();
        let micros = tick_started.elapsed().as_micros();
        max_tick_micros = max_tick_micros.max(micros);
        let bucket = usize::try_from(micros.min(100_000)).unwrap_or(100_000);
        tick_histogram[bucket] += 1;
    }
    let elapsed = started.elapsed();
    let stats = source.stats();
    println!(
        "{}",
        serde_json::to_string_pretty(&json!({
            "schema": "pi-workflows.viewer-refresh-benchmark.v1",
            "databaseBytes": database_bytes,
            "runCount": run_count,
            "ticks": ticks,
            "elapsedMicros": elapsed.as_micros(),
            "averageTickMicros": elapsed.as_micros() / u128::from(ticks.max(1)),
            "medianTickMicros": percentile(&tick_histogram, ticks, 50),
            "p95TickMicros": percentile(&tick_histogram, ticks, 95),
            "p99TickMicros": percentile(&tick_histogram, ticks, 99),
            "maxTickMicros": max_tick_micros,
            "dataVersionChecks": stats.data_version_checks,
            "indexReads": stats.index_reads,
            "windowReads": stats.window_reads,
            "pageReads": stats.page_reads,
            "payloadRowsRead": stats.payload_rows_read,
            "peakRssKiB": peak_rss_kib(),
        }))?
    );
    Ok(())
}

fn percentile(histogram: &[u64], total: u64, percentile: u64) -> usize {
    if total == 0 {
        return 0;
    }
    let target = (total.saturating_mul(percentile).saturating_add(99) / 100).max(1);
    let mut seen = 0_u64;
    for (micros, count) in histogram.iter().enumerate() {
        seen += count;
        if seen >= target {
            return micros;
        }
    }
    histogram.len().saturating_sub(1)
}

fn peak_rss_kib() -> Option<u64> {
    let status = std::fs::read_to_string("/proc/self/status").ok()?;
    status.lines().find_map(|line| {
        line.strip_prefix("VmHWM:")?
            .split_whitespace()
            .next()?
            .parse()
            .ok()
    })
}
