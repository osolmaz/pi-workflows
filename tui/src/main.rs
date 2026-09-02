use anyhow::{Context, Result};
use clap::{Parser, Subcommand};
use piw::{server, ui};
use std::path::PathBuf;
use std::process::Command as ProcessCommand;
use std::time::{Duration, Instant};
#[cfg(windows)]
use tokio::net::windows::named_pipe::ClientOptions;

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

    /// Render one complete view as plain text and exit.
    #[arg(
        long,
        requires = "run_id",
        conflicts_with_all = ["connect", "list_themes"]
    )]
    once: bool,

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

fn state_directory() -> PathBuf {
    std::env::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".pi")
        .join("agent")
        .join("workflows")
}

fn default_socket() -> PathBuf {
    let state_directory = state_directory();
    #[cfg(unix)]
    return state_directory.join("host").join("host.sock");
    #[cfg(windows)]
    {
        use sha2::{Digest, Sha256};
        let digest = Sha256::digest(state_directory.to_string_lossy().as_bytes());
        let suffix = digest[..12]
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        return PathBuf::from(format!(r"\\.\pipe\pi-workflows-{suffix}"));
    }
    #[cfg(not(any(unix, windows)))]
    state_directory.join("host").join("host.sock")
}

async fn host_available(socket_path: &PathBuf) -> bool {
    #[cfg(unix)]
    return tokio::net::UnixStream::connect(socket_path).await.is_ok();
    #[cfg(windows)]
    return ClientOptions::new().open(socket_path).is_ok();
    #[cfg(not(any(unix, windows)))]
    socket_path.exists()
}

async fn ensure_host(socket_path: &PathBuf) -> Result<()> {
    if host_available(socket_path).await {
        return Ok(());
    }
    let status = ProcessCommand::new("pi-workflows")
        .args(["host", "start"])
        .status()
        .context("starting the installed pi-workflows host")?;
    anyhow::ensure!(status.success(), "pi-workflows host start failed");
    let deadline = Instant::now() + Duration::from_secs(10);
    while Instant::now() < deadline {
        if host_available(socket_path).await {
            return Ok(());
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    anyhow::bail!(
        "workflow host endpoint did not become ready at {}",
        socket_path.display()
    )
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    anyhow::ensure!(
        !(cli.once && cli.command.is_some()),
        "--once cannot be used with a subcommand"
    );
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
    let runtime = tokio::runtime::Runtime::new()?;
    runtime.block_on(ensure_host(&socket_path))?;
    match cli.command {
        Some(Command::Serve { bind }) => {
            runtime.block_on(server::serve(server::ServeOptions { socket_path, bind }))
        }
        None => {
            drop(runtime);
            match cli.run_id {
                Some(run_id) if cli.once => {
                    println!(
                        "{}",
                        ui::render_single_once(&socket_path, &run_id, cli_theme.as_deref())?
                    );
                    Ok(())
                }
                Some(run_id) => ui::run_single(&socket_path, &run_id, cli_theme.as_deref()),
                None => ui::run_local(&socket_path, cli_theme.as_deref()),
            }
        }
    }
}
