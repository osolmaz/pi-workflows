//! piw: terminal viewer and live replay server for pi-workflows SQLite workflow state.
//! The library form exists for integration tests; `main.rs` is the CLI.

pub mod canvas;
pub mod client;
pub mod format;
pub mod layout;
pub mod protocol;
pub mod render;
pub mod server;
pub mod session;
pub mod state;
pub mod theme;
pub mod ui;
