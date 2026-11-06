#![windows_subsystem = "windows"]

#[cfg(windows)]
fn main() {
    std::process::exit(conduit_tray::win::run());
}

#[cfg(not(windows))]
fn main() {
    std::process::exit(conduit_tray::protocol::EXIT_PROTOCOL);
}
