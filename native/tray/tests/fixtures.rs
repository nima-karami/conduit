use conduit_tray::protocol::{parse_incoming_line, validate_helper_fixture};
use serde::Deserialize;
use std::fs;
use std::path::PathBuf;

#[derive(Deserialize)]
struct Fixture {
    valid: bool,
    dir: Direction,
    line: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
enum Direction {
    ToHelper,
    FromHelper,
}

#[test]
fn shared_protocol_fixtures_match_the_rust_mirror() {
    let fixture_dir =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../test/fixtures/tray-protocol");
    let mut paths = fs::read_dir(&fixture_dir)
        .expect("shared fixture directory")
        .map(|entry| entry.expect("fixture entry").path())
        .collect::<Vec<_>>();
    paths.sort();

    assert_eq!(paths.len(), 17, "all committed C8b fixtures are covered");
    for path in paths {
        let fixture: Fixture =
            serde_json::from_slice(&fs::read(&path).expect("fixture contents")).expect("fixture");
        let result = match fixture.dir {
            Direction::ToHelper => parse_incoming_line(&fixture.line).map(|_| ()),
            Direction::FromHelper => validate_helper_fixture(&fixture.line),
        };
        assert_eq!(
            result.is_ok(),
            fixture.valid,
            "fixture {} expected valid={}",
            path.display(),
            fixture.valid
        );
    }
}
