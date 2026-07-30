//! piw: terminal viewer and live replay server for pi-workflows run bundles.
//! The library form exists for integration tests; `main.rs` is the CLI.

pub mod bundle;
pub mod canvas;
pub mod client;
pub mod format;
pub mod layout;
pub mod protocol;
pub mod render;
pub mod server;
pub mod session;
pub mod source;
pub mod theme;
pub mod ui;
