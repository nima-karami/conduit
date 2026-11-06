use crate::protocol::{
    ActionId, AppLaunch, Confirm, Incoming, LogLevel, Outgoing, TrayItem, TrayView, EXIT_ASKED,
    EXIT_PROTOCOL, EXIT_SHELL_UNAVAILABLE,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MenuAction {
    Open,
    StopAll,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum UserEvent {
    MenuOpen,
    MenuPick(MenuAction),
    Confirm(bool),
    IconSelect,
    ErrorClosed,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ShellEvent {
    AddResult(bool),
    TaskbarCreated,
    RetryTick,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Effect {
    Show(TrayView),
    Hide,
    Send(Outgoing),
    OpenConfirm(Confirm),
    ShowError { title: String, body: String },
    Launch(AppLaunch),
    ScheduleRetry(u32),
    Exit(i32),
}

#[derive(Default)]
pub struct Model {
    app: Option<AppLaunch>,
    view: Option<TrayView>,
    icon_visible: bool,
    confirm_open: bool,
    stop_pending: bool,
    error_open: bool,
    exit_pending: bool,
    retry_started_ms: Option<u64>,
}

impl Model {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn on_supervisor(&mut self, message: Incoming) -> Vec<Effect> {
        match message {
            Incoming::Init { app } => {
                self.app = app;
                Vec::new()
            }
            Incoming::View { mut view } => {
                view.tooltip = truncate_utf16(&view.tooltip, 127);
                let was_desired_visible =
                    self.view.as_ref().is_some_and(|previous| previous.visible);
                self.view = Some(view.clone());
                if view.visible {
                    vec![Effect::Show(view)]
                } else if self.icon_visible || was_desired_visible {
                    self.icon_visible = false;
                    self.retry_started_ms = None;
                    vec![Effect::Hide, Effect::Send(Outgoing::Hidden)]
                } else {
                    Vec::new()
                }
            }
            Incoming::StopResultOk => {
                self.stop_pending = false;
                Vec::new()
            }
            Incoming::StopResultFailed { title, body } => {
                self.stop_pending = false;
                self.error_open = true;
                vec![Effect::ShowError { title, body }]
            }
            Incoming::Exit => {
                self.icon_visible = false;
                let mut effects = vec![Effect::Hide, Effect::Send(Outgoing::Hidden)];
                if self.error_open {
                    self.exit_pending = true;
                } else {
                    effects.push(Effect::Exit(EXIT_ASKED));
                }
                effects
            }
            Incoming::Unknown(message_type) => vec![Effect::Send(Outgoing::Log {
                level: LogLevel::Warn,
                message: format!("Ignored unknown supervisor message: {message_type}"),
            })],
            Incoming::ProtocolError => vec![Effect::Exit(EXIT_PROTOCOL)],
        }
    }

    pub fn on_user(&mut self, event: UserEvent) -> Vec<Effect> {
        match event {
            UserEvent::MenuOpen => Vec::new(),
            UserEvent::MenuPick(MenuAction::Open) | UserEvent::IconSelect => {
                self.app.clone().map(Effect::Launch).into_iter().collect()
            }
            UserEvent::MenuPick(MenuAction::StopAll) => {
                if self.stop_pending || !self.stop_is_enabled() {
                    return Vec::new();
                }
                let Some(confirm) = self.view.as_ref().map(|view| view.confirm.clone()) else {
                    return Vec::new();
                };
                self.confirm_open = true;
                vec![Effect::OpenConfirm(confirm)]
            }
            UserEvent::Confirm(false) => {
                self.confirm_open = false;
                Vec::new()
            }
            UserEvent::Confirm(true) => {
                if !self.confirm_open || self.stop_pending {
                    return Vec::new();
                }
                self.confirm_open = false;
                self.stop_pending = true;
                vec![Effect::Send(Outgoing::StopAll)]
            }
            UserEvent::ErrorClosed => {
                self.error_open = false;
                if self.exit_pending {
                    self.exit_pending = false;
                    vec![Effect::Exit(EXIT_ASKED)]
                } else {
                    Vec::new()
                }
            }
        }
    }

    pub fn on_shell(&mut self, event: ShellEvent, now_ms: u64) -> Vec<Effect> {
        match event {
            ShellEvent::AddResult(true) => {
                let was_visible = self.icon_visible;
                self.icon_visible = true;
                self.retry_started_ms = None;
                if was_visible {
                    Vec::new()
                } else {
                    vec![Effect::Send(Outgoing::Shown)]
                }
            }
            ShellEvent::AddResult(false) => {
                let started = *self.retry_started_ms.get_or_insert(now_ms);
                if now_ms.saturating_sub(started) >= 60_000 {
                    vec![Effect::Exit(EXIT_SHELL_UNAVAILABLE)]
                } else {
                    vec![Effect::ScheduleRetry(2_000)]
                }
            }
            ShellEvent::TaskbarCreated => {
                self.icon_visible = false;
                self.retry_started_ms = None;
                self.visible_view().map(Effect::Show).into_iter().collect()
            }
            ShellEvent::RetryTick => self.visible_view().map(Effect::Show).into_iter().collect(),
        }
    }

    fn visible_view(&self) -> Option<TrayView> {
        self.view.as_ref().filter(|view| view.visible).cloned()
    }

    fn stop_is_enabled(&self) -> bool {
        self.view.as_ref().is_some_and(|view| {
            view.items.iter().any(|item| {
                matches!(
                    item,
                    TrayItem::Action {
                        id: ActionId::StopAll,
                        enabled: true,
                        ..
                    }
                )
            })
        })
    }
}

pub fn truncate_utf16(value: &str, max_units: usize) -> String {
    let mut units = 0;
    value
        .chars()
        .take_while(|character| {
            let next = units + character.len_utf16();
            if next > max_units {
                false
            } else {
                units = next;
                true
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::{truncate_utf16, Effect, MenuAction, Model, ShellEvent, UserEvent};
    use crate::protocol::{
        ActionId, Confirm, Incoming, OpenFailed, Outgoing, TrayIcon, TrayItem, TrayView,
        EXIT_ASKED, EXIT_PROTOCOL, EXIT_SHELL_UNAVAILABLE,
    };

    fn view(visible: bool) -> TrayView {
        TrayView {
            visible,
            icon: TrayIcon::Normal,
            tooltip: "Conduit".to_owned(),
            items: if visible {
                vec![
                    TrayItem::Action {
                        id: ActionId::Open,
                        text: "Open Conduit".to_owned(),
                        enabled: true,
                        is_default: true,
                    },
                    TrayItem::Action {
                        id: ActionId::StopAll,
                        text: "Stop all agents…".to_owned(),
                        enabled: true,
                        is_default: false,
                    },
                ]
            } else {
                Vec::new()
            },
            confirm: Confirm {
                title: "Stop all agents?".to_owned(),
                body: "Anything not saved is lost.".to_owned(),
                confirm: "Stop all agents".to_owned(),
                cancel: "Cancel".to_owned(),
            },
            open_failed: OpenFailed {
                title: "Could not open Conduit".to_owned(),
                body: "Conduit could not be opened: {reason}".to_owned(),
            },
        }
    }

    fn visible_model() -> Model {
        let mut model = Model::new();
        model.on_supervisor(Incoming::View { view: view(true) });
        model.on_shell(ShellEvent::AddResult(true), 0);
        model
    }

    #[test]
    fn protocol_error_exits_with_protocol_code() {
        let mut model = Model::new();
        let incoming = crate::protocol::parse_incoming_line(r#"{"type":"init","v":2,"app":null}"#)
            .unwrap_or(Incoming::ProtocolError);
        assert_eq!(
            model.on_supervisor(incoming),
            vec![Effect::Exit(EXIT_PROTOCOL)]
        );
    }

    #[test]
    fn stop_latch_sends_once_after_confirm_and_releases_after_result() {
        let mut model = visible_model();
        assert!(matches!(
            model
                .on_user(UserEvent::MenuPick(MenuAction::StopAll))
                .as_slice(),
            [Effect::OpenConfirm(_)]
        ));
        assert!(model.on_user(UserEvent::Confirm(false)).is_empty());

        model.on_user(UserEvent::MenuPick(MenuAction::StopAll));
        assert_eq!(
            model.on_user(UserEvent::Confirm(true)),
            vec![Effect::Send(Outgoing::StopAll)]
        );
        model.on_user(UserEvent::MenuPick(MenuAction::StopAll));
        assert!(model.on_user(UserEvent::Confirm(true)).is_empty());

        assert!(model.on_supervisor(Incoming::StopResultOk).is_empty());
        model.on_user(UserEvent::MenuPick(MenuAction::StopAll));
        assert_eq!(
            model.on_user(UserEvent::Confirm(true)),
            vec![Effect::Send(Outgoing::StopAll)]
        );
    }

    #[test]
    fn failed_stop_shows_error_and_releases_latch() {
        let mut model = visible_model();
        model.on_user(UserEvent::MenuPick(MenuAction::StopAll));
        model.on_user(UserEvent::Confirm(true));
        assert_eq!(
            model.on_supervisor(Incoming::StopResultFailed {
                title: "Could not stop".to_owned(),
                body: "Try again".to_owned(),
            }),
            vec![Effect::ShowError {
                title: "Could not stop".to_owned(),
                body: "Try again".to_owned(),
            }]
        );
        model.on_user(UserEvent::ErrorClosed);
        model.on_user(UserEvent::MenuPick(MenuAction::StopAll));
        assert_eq!(
            model.on_user(UserEvent::Confirm(true)),
            vec![Effect::Send(Outgoing::StopAll)]
        );
    }

    #[test]
    fn truncates_tooltip_at_utf16_boundary() {
        let fits = format!("{}😀", "a".repeat(125));
        assert_eq!(truncate_utf16(&fits, 127), fits);

        let split = format!("{}😀", "a".repeat(126));
        assert_eq!(truncate_utf16(&split, 127), "a".repeat(126));
        assert_eq!(truncate_utf16(&"a".repeat(128), 127), "a".repeat(127));
    }

    #[test]
    fn exit_hides_and_reports_hidden_before_exiting() {
        let mut model = visible_model();
        assert_eq!(
            model.on_supervisor(Incoming::Exit),
            vec![
                Effect::Hide,
                Effect::Send(Outgoing::Hidden),
                Effect::Exit(EXIT_ASKED),
            ]
        );
    }

    #[test]
    fn exit_waits_for_an_open_error_dialog() {
        let mut model = visible_model();
        model.on_user(UserEvent::MenuPick(MenuAction::StopAll));
        model.on_user(UserEvent::Confirm(true));
        model.on_supervisor(Incoming::StopResultFailed {
            title: "Could not stop".to_owned(),
            body: "Try again".to_owned(),
        });

        assert_eq!(
            model.on_supervisor(Incoming::Exit),
            vec![Effect::Hide, Effect::Send(Outgoing::Hidden)]
        );
        assert_eq!(
            model.on_user(UserEvent::ErrorClosed),
            vec![Effect::Exit(EXIT_ASKED)]
        );
    }

    #[test]
    fn taskbar_created_readds_a_visible_icon() {
        let mut model = visible_model();
        assert_eq!(
            model.on_shell(ShellEvent::TaskbarCreated, 1),
            vec![Effect::Show(view(true))]
        );
    }

    #[test]
    fn failed_add_retries_every_two_seconds_for_sixty_seconds() {
        let mut model = Model::new();
        model.on_supervisor(Incoming::View { view: view(true) });
        assert_eq!(
            model.on_shell(ShellEvent::AddResult(false), 0),
            vec![Effect::ScheduleRetry(2_000)]
        );
        assert_eq!(
            model.on_shell(ShellEvent::RetryTick, 2_000),
            vec![Effect::Show(view(true))]
        );
        assert_eq!(
            model.on_shell(ShellEvent::AddResult(false), 59_999),
            vec![Effect::ScheduleRetry(2_000)]
        );
        assert_eq!(
            model.on_shell(ShellEvent::AddResult(false), 60_000),
            vec![Effect::Exit(EXIT_SHELL_UNAVAILABLE)]
        );
    }

    #[test]
    fn hidden_view_deletes_only_once() {
        let mut model = visible_model();
        assert_eq!(
            model.on_supervisor(Incoming::View { view: view(false) }),
            vec![Effect::Hide, Effect::Send(Outgoing::Hidden)]
        );
        assert!(model
            .on_supervisor(Incoming::View { view: view(false) })
            .is_empty());
    }

    #[test]
    fn icon_select_without_app_does_nothing() {
        let mut model = Model::new();
        model.on_supervisor(Incoming::Init { app: None });
        assert!(model.on_user(UserEvent::IconSelect).is_empty());
    }
}
