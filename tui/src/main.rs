use anyhow::Result;
use clap::{Parser, Subcommand};
use piw::{server, ui};
use std::path::PathBuf;

/// Terminal viewer and live replay server for pi-workflows run bundles.
#[derive(Parser)]
#[command(name = "piw", version, about)]
struct Cli {
    /// Runs directory or a single run bundle directory
    /// (default: ~/.pi/agent/workflows/runs).
    path: Option<PathBuf>,

    /// Connect to a `piw serve` server instead of reading the filesystem.
    #[arg(long, value_name = "URL", conflicts_with = "path")]
    connect: Option<String>,

    #[command(subcommand)]
    command: Option<Command>,
}

#[derive(Subcommand)]
enum Command {
    /// Serve run views over the live replay protocol (WebSocket).
    Serve {
        /// Runs directory to watch (default: ~/.pi/agent/workflows/runs).
        #[arg(long, value_name = "DIR")]
        runs_dir: Option<PathBuf>,
        /// Address to bind. Bundles contain private data; keep this local.
        #[arg(long, default_value = "127.0.0.1:9377")]
        bind: String,
    },
}

fn default_runs_dir() -> PathBuf {
    std::env::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".pi")
        .join("agent")
        .join("workflows")
        .join("runs")
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    match cli.command {
        Some(Command::Serve { runs_dir, bind }) => {
            let runs_dir = runs_dir.unwrap_or_else(default_runs_dir);
            anyhow::ensure!(
                runs_dir.is_dir(),
                "runs directory {} does not exist",
                runs_dir.display()
            );
            let runtime = tokio::runtime::Runtime::new()?;
            runtime.block_on(server::serve(server::ServeOptions { runs_dir, bind }))
        }
        None => {
            if let Some(url) = cli.connect {
                return ui::run_remote(&url);
            }
            let path = cli.path.unwrap_or_else(default_runs_dir);
            anyhow::ensure!(path.is_dir(), "{} does not exist", path.display());
            // A directory containing manifest.json is a single bundle;
            // anything else is treated as a runs directory.
            if path.join("manifest.json").is_file() {
                ui::run_single(&path)
            } else {
                ui::run_local(&path)
            }
        }
    }
}
