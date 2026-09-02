use std::process::Command;

fn piw() -> Command {
    Command::new(env!("CARGO_BIN_EXE_piw"))
}

#[test]
fn once_requires_a_run_id() {
    let output = piw().arg("--once").output().expect("piw should start");

    assert_eq!(output.status.code(), Some(2));
    let stderr = String::from_utf8(output.stderr).expect("stderr should be UTF-8");
    assert!(stderr.contains("required arguments were not provided"));
    assert!(stderr.contains("<RUN_ID>"));
}

#[test]
fn help_describes_one_frame_rendering() {
    let output = piw().arg("--help").output().expect("piw should start");

    assert!(output.status.success());
    let stdout = String::from_utf8(output.stdout).expect("stdout should be UTF-8");
    assert!(stdout.contains("--once"));
    assert!(stdout.contains("Render one complete view as plain text and exit"));
}
