use anyhow::Result;
use clap::{Parser, Subcommand};
use piw::{server, ui};
use std::path::PathBuf;

/// Terminal viewer and replay server for pi-workflows SQLite state.
#[derive(Parser)]
#[command(name = "piw", version, about)]
struct Cli {
    /// Optional run id. Without one, show all runs.
    run_id: Option<String>,

    /// Connect to a `piw serve` server instead of reading local state.
    #[arg(long, value_name = "URL", conflicts_with = "run_id")]
    connect: Option<String>,

    /// Viewer theme name. Overrides PIW_THEME and the config file.
    #[arg(long, value_name = "NAME")]
    theme: Option<String>,

    /// Print built-in viewer theme names and exit.
    #[arg(long)]
    list_themes: bool,

    #[command(subcommand)]
    command: Option<Command>,
}

#[derive(Subcommand)]
enum Command {
    /// Serve run views over the local replay protocol.
    Serve {
        /// Address to bind. Workflow state can contain private data; keep this local.
        #[arg(long, default_value = "127.0.0.1:9377")]
        bind: String,
    },
}

fn default_database() -> PathBuf {
    std::env::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".pi")
        .join("agent")
        .join("workflows")
        .join("state.sqlite")
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    if cli.list_themes {
        for name in piw::theme::THEME_NAMES {
            println!("{name}");
        }
        return Ok(());
    }
    let database = default_database();
    anyhow::ensure!(
        database.is_file(),
        "Pi Workflows database {} does not exist",
        database.display()
    );
    let cli_theme = cli.theme.clone();
    match cli.command {
        Some(Command::Serve { bind }) => {
            let runtime = tokio::runtime::Runtime::new()?;
            runtime.block_on(server::serve(server::ServeOptions {
                database_path: database,
                bind,
            }))
        }
        None => {
            if let Some(url) = cli.connect {
                return ui::run_remote(&url, cli_theme.as_deref());
            }
            match cli.run_id {
                Some(run_id) => ui::run_single(&database, &run_id, cli_theme.as_deref()),
                None => ui::run_local(&database, cli_theme.as_deref()),
            }
        }
    }
}
