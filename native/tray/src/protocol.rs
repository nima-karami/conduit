use serde::{Deserialize, Serialize};

pub const PROTOCOL_VERSION: u32 = 1;
pub const EXIT_ASKED: i32 = 0;
pub const EXIT_SHELL_UNAVAILABLE: i32 = 10;
pub const EXIT_PROTOCOL: i32 = 11;

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
pub struct AppLaunch {
    pub exe: String,
    pub args: Vec<String>,
    pub cwd: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TrayView {
    pub visible: bool,
    pub icon: TrayIcon,
    pub tooltip: String,
    pub items: Vec<TrayItem>,
    pub confirm: Confirm,
    pub open_failed: OpenFailed,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum TrayIcon {
    Normal,
    NeedsYou,
    Warning,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum TrayItem {
    Label {
        text: String,
    },
    Separator,
    Action {
        id: ActionId,
        text: String,
        enabled: bool,
        #[serde(default, rename = "isDefault")]
        is_default: bool,
    },
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ActionId {
    Open,
    StopAll,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
pub struct Confirm {
    pub title: String,
    pub body: String,
    pub confirm: String,
    pub cancel: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
pub struct OpenFailed {
    pub title: String,
    pub body: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Incoming {
    Init { app: Option<AppLaunch> },
    View { view: TrayView },
    StopResultOk,
    StopResultFailed { title: String, body: String },
    Exit,
    Unknown(String),
    ProtocolError,
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum LogLevel {
    Info,
    Warn,
    Error,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(tag = "type")]
pub enum Outgoing {
    #[serde(rename = "hello")]
    Hello {
        v: u32,
        #[serde(rename = "helperVersion")]
        helper_version: String,
        pid: u32,
    },
    #[serde(rename = "shown")]
    Shown,
    #[serde(rename = "hidden")]
    Hidden,
    #[serde(rename = "stopAll")]
    StopAll,
    #[serde(rename = "opened")]
    Opened,
    #[serde(rename = "openFailed")]
    OpenFailed { reason: String },
    #[serde(rename = "log")]
    Log { level: LogLevel, message: String },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProtocolError(pub String);

pub fn parse_incoming_line(line: &str) -> Result<Incoming, ProtocolError> {
    let value: serde_json::Value =
        serde_json::from_str(line).map_err(|error| ProtocolError(error.to_string()))?;
    let message_type = value
        .get("type")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| ProtocolError("message type is missing".to_owned()))?;

    match message_type {
        "init" => {
            let version = value
                .get("v")
                .and_then(serde_json::Value::as_u64)
                .ok_or_else(|| ProtocolError("init version is missing".to_owned()))?;
            if version != u64::from(PROTOCOL_VERSION) {
                return Err(ProtocolError(format!(
                    "unsupported protocol version {version}"
                )));
            }
            let app = serde_json::from_value(
                value
                    .get("app")
                    .cloned()
                    .ok_or_else(|| ProtocolError("init app is missing".to_owned()))?,
            )
            .map_err(|error| ProtocolError(error.to_string()))?;
            Ok(Incoming::Init { app })
        }
        "view" => serde_json::from_value(
            value
                .get("view")
                .cloned()
                .ok_or_else(|| ProtocolError("view payload is missing".to_owned()))?,
        )
        .map(|view| Incoming::View { view })
        .map_err(|error| ProtocolError(error.to_string())),
        "stopResult" => match value.get("ok").and_then(serde_json::Value::as_bool) {
            Some(true) => Ok(Incoming::StopResultOk),
            Some(false) => {
                let title = required_string(&value, "title")?;
                let body = required_string(&value, "body")?;
                Ok(Incoming::StopResultFailed { title, body })
            }
            None => Err(ProtocolError("stopResult ok is missing".to_owned())),
        },
        "exit" => Ok(Incoming::Exit),
        other => Ok(Incoming::Unknown(other.to_owned())),
    }
}

pub fn validate_helper_fixture(line: &str) -> Result<(), ProtocolError> {
    let value: serde_json::Value =
        serde_json::from_str(line).map_err(|error| ProtocolError(error.to_string()))?;
    let message_type = value
        .get("type")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| ProtocolError("message type is missing".to_owned()))?;

    match message_type {
        "hello" => {
            let version = value
                .get("v")
                .and_then(serde_json::Value::as_u64)
                .ok_or_else(|| ProtocolError("hello version is missing".to_owned()))?;
            if version != u64::from(PROTOCOL_VERSION) {
                return Err(ProtocolError(format!(
                    "unsupported protocol version {version}"
                )));
            }
            required_string(&value, "helperVersion")?;
            value
                .get("pid")
                .and_then(serde_json::Value::as_u64)
                .ok_or_else(|| ProtocolError("hello pid is missing".to_owned()))?;
        }
        "shown" | "hidden" | "stopAll" | "opened" => {}
        "openFailed" => {
            required_string(&value, "reason")?;
        }
        "log" => {
            required_string(&value, "message")?;
            match value.get("level").and_then(serde_json::Value::as_str) {
                Some("info" | "warn" | "error") => {}
                _ => return Err(ProtocolError("invalid log level".to_owned())),
            }
        }
        _ => {}
    }
    Ok(())
}

fn required_string(value: &serde_json::Value, field: &str) -> Result<String, ProtocolError> {
    value
        .get(field)
        .and_then(serde_json::Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| ProtocolError(format!("{field} is missing")))
}
