use anyhow::{Context, Result};
use clap::{Parser, Subcommand};
use piw::{server, ui};
use std::path::PathBuf;
use std::process::Command as ProcessCommand;
use std::time::{Duration, Instant};

/// Terminal viewer and client relay for hosted pi-workflows state.
#[derive(Parser)]
#[command(name = "piw", version, about)]
struct Cli {
    /// Optional run id. Without one, show all runs.
    run_id: Option<String>,

    /// Connect to a `piw serve` relay instead of the local workflow host.
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
    /// Relay each WebSocket connection to one local workflow host connection.
    Serve {
        /// Address to bind. Workflow state can contain private data; keep this local.
        #[arg(long, default_value = "127.0.0.1:9377")]
        bind: String,
    },
}

fn default_socket() -> PathBuf {
    std::env::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".pi")
        .join("agent")
        .join("workflows")
        .join("host")
        .join("host.sock")
}

fn ensure_host(socket_path: &PathBuf) -> Result<()> {
    #[cfg(unix)]
    if std::os::unix::net::UnixStream::connect(socket_path).is_ok() {
        return Ok(());
    }
    #[cfg(not(unix))]
    if socket_path.exists() {
        return Ok(());
    }
    let status = ProcessCommand::new("pi-workflows")
        .args(["host", "start"])
        .status()
        .context("starting the installed pi-workflows host")?;
    anyhow::ensure!(status.success(), "pi-workflows host start failed");
    let deadline = Instant::now() + Duration::from_secs(10);
    while Instant::now() < deadline {
        if socket_path.exists() {
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    anyhow::bail!(
        "workflow host socket did not appear at {}",
        socket_path.display()
    )
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    if cli.list_themes {
        for name in piw::theme::THEME_NAMES {
            println!("{name}");
        }
        return Ok(());
    }
    let cli_theme = cli.theme.clone();
    if cli.command.is_none() {
        if let Some(url) = cli.connect.as_deref() {
            return ui::run_remote(url, cli_theme.as_deref());
        }
    }
    let socket_path = default_socket();
    ensure_host(&socket_path)?;
    match cli.command {
        Some(Command::Serve { bind }) => {
            let runtime = tokio::runtime::Runtime::new()?;
            runtime.block_on(server::serve(server::ServeOptions { socket_path, bind }))
        }
        None => match cli.run_id {
            Some(run_id) => ui::run_single(&socket_path, &run_id, cli_theme.as_deref()),
            None => ui::run_local(&socket_path, cli_theme.as_deref()),
        },
    }
}
