mod dialog;
mod icon;
mod menu;

use crate::framing::LineReader;
use crate::launch;
use crate::model::{Effect, Model, ShellEvent, UserEvent};
use crate::protocol::{
    parse_incoming_line, Incoming, Outgoing, TrayView, EXIT_SHELL_UNAVAILABLE, PROTOCOL_VERSION,
};
use icon::TrayIconHost;
use std::io::{BufWriter, Write};
use std::ptr::{null, null_mut};
use std::sync::mpsc::{self, Sender};
use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
use windows_sys::Win32::System::SystemInformation::GetTickCount64;
use windows_sys::Win32::UI::Shell::NIN_SELECT;
use windows_sys::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, GetMessageW,
    GetWindowLongPtrW, KillTimer, PostMessageW, PostQuitMessage, RegisterClassW,
    RegisterWindowMessageW, SetTimer, SetWindowLongPtrW, TranslateMessage, UnregisterClassW,
    GWLP_USERDATA, MSG, WM_APP, WM_CONTEXTMENU, WM_DESTROY, WM_TIMER, WNDCLASSW, WS_OVERLAPPED,
};

const WM_TRAY_CALLBACK: u32 = WM_APP + 1;
const WM_SUPERVISOR: u32 = WM_APP + 2;
const RETRY_TIMER_ID: usize = 1;
const NIN_KEYSELECT: u32 = NIN_SELECT + 1;

pub fn run() -> i32 {
    let class_name = wide("ConduitTrayHelperWindow");
    let taskbar_created = unsafe { RegisterWindowMessageW(wide("TaskbarCreated").as_ptr()) };
    if taskbar_created == 0 {
        return EXIT_SHELL_UNAVAILABLE;
    }
    let instance = unsafe { GetModuleHandleW(null()) };
    let class = WNDCLASSW {
        lpfnWndProc: Some(window_proc),
        hInstance: instance,
        lpszClassName: class_name.as_ptr(),
        ..Default::default()
    };
    if unsafe { RegisterClassW(&class) } == 0 {
        return EXIT_SHELL_UNAVAILABLE;
    }

    let hwnd = unsafe {
        CreateWindowExW(
            0,
            class_name.as_ptr(),
            class_name.as_ptr(),
            WS_OVERLAPPED,
            0,
            0,
            0,
            0,
            null_mut(),
            null_mut(),
            instance,
            null(),
        )
    };
    if hwnd.is_null() {
        unsafe {
            UnregisterClassW(class_name.as_ptr(), instance);
        }
        return EXIT_SHELL_UNAVAILABLE;
    }

    let (sender, receiver) = mpsc::channel();
    spawn_stdin_reader(hwnd, sender.clone());
    let mut window_context = Box::new(WindowContext {
        taskbar_created,
        sender,
    });
    unsafe {
        SetWindowLongPtrW(
            hwnd,
            GWLP_USERDATA,
            (&mut *window_context as *mut WindowContext).cast::<()>() as isize,
        );
    }
    let mut state = State::new(hwnd);
    state.send(&Outgoing::Hello {
        v: PROTOCOL_VERSION,
        helper_version: env!("CARGO_PKG_VERSION").to_owned(),
        pid: std::process::id(),
    });

    let mut message = MSG::default();
    loop {
        let result = unsafe { GetMessageW(&mut message, null_mut(), 0, 0) };
        if result == -1 {
            state.exit_code = EXIT_SHELL_UNAVAILABLE;
            break;
        }
        if result == 0 {
            break;
        }
        unsafe {
            TranslateMessage(&message);
            DispatchMessageW(&message);
        }
        while let Ok(event) = receiver.try_recv() {
            state.handle(event);
        }
    }

    unsafe {
        SetWindowLongPtrW(hwnd, GWLP_USERDATA, 0);
        DestroyWindow(hwnd);
        UnregisterClassW(class_name.as_ptr(), instance);
    }
    state.exit_code
}

struct State {
    hwnd: HWND,
    model: Model,
    icon: TrayIconHost,
    view: Option<TrayView>,
    output: BufWriter<std::io::Stdout>,
    exit_code: i32,
}

impl State {
    fn new(hwnd: HWND) -> Self {
        Self {
            hwnd,
            model: Model::new(),
            icon: TrayIconHost::new(hwnd, WM_TRAY_CALLBACK),
            view: None,
            output: BufWriter::new(std::io::stdout()),
            exit_code: 0,
        }
    }

    fn handle(&mut self, event: NativeEvent) {
        match event {
            NativeEvent::Supervisor(message) => {
                let effects = self.model.on_supervisor(message);
                self.apply(effects);
            }
            NativeEvent::Tray(event) => self.tray_callback(event),
            NativeEvent::TaskbarCreated => {
                self.icon.taskbar_recreated();
                let effects = self.model.on_shell(ShellEvent::TaskbarCreated, now_ms());
                self.apply(effects);
            }
            NativeEvent::Retry => {
                let effects = self.model.on_shell(ShellEvent::RetryTick, now_ms());
                self.apply(effects);
            }
        }
    }

    fn tray_callback(&mut self, event: u32) {
        match event {
            WM_CONTEXTMENU => {
                let effects = self.model.on_user(UserEvent::MenuOpen);
                self.apply(effects);
                if let Some(view) = self.view.as_ref() {
                    if let Some(action) = menu::show(self.hwnd, view) {
                        let effects = self.model.on_user(UserEvent::MenuPick(action));
                        self.apply(effects);
                    }
                }
            }
            NIN_SELECT | NIN_KEYSELECT => {
                let effects = self.model.on_user(UserEvent::IconSelect);
                self.apply(effects);
            }
            _ => {}
        }
    }

    fn apply(&mut self, effects: Vec<Effect>) {
        for effect in effects {
            match effect {
                Effect::Show(view) => {
                    self.view = Some(view.clone());
                    let added = self.icon.show(&view);
                    let effects = self.model.on_shell(ShellEvent::AddResult(added), now_ms());
                    self.apply(effects);
                }
                Effect::Hide => self.icon.hide(),
                Effect::Send(message) => self.send(&message),
                Effect::OpenConfirm(copy) => {
                    let confirmed = dialog::confirm(self.hwnd, &copy);
                    let effects = self.model.on_user(UserEvent::Confirm(confirmed));
                    self.apply(effects);
                }
                Effect::ShowError { title, body } => {
                    dialog::error(self.hwnd, &title, &body);
                    let effects = self.model.on_user(UserEvent::ErrorClosed);
                    self.apply(effects);
                }
                Effect::Launch(app) => match launch::launch(&app) {
                    Ok(()) => self.send(&Outgoing::Opened),
                    Err(reason) => {
                        self.send(&Outgoing::OpenFailed {
                            reason: reason.clone(),
                        });
                        if let Some(view) = self.view.as_ref() {
                            let body = view.open_failed.body.replace("{reason}", &reason);
                            dialog::error(self.hwnd, &view.open_failed.title, &body);
                        }
                    }
                },
                Effect::ScheduleRetry(delay_ms) => {
                    if unsafe { SetTimer(self.hwnd, RETRY_TIMER_ID, delay_ms, None) } == 0 {
                        self.exit_code = EXIT_SHELL_UNAVAILABLE;
                        unsafe {
                            PostQuitMessage(self.exit_code);
                        }
                    }
                }
                Effect::Exit(code) => {
                    self.exit_code = code;
                    unsafe {
                        PostQuitMessage(code);
                    }
                }
            }
        }
    }

    fn send(&mut self, message: &Outgoing) {
        let result = serde_json::to_writer(&mut self.output, message)
            .map_err(std::io::Error::other)
            .and_then(|()| self.output.write_all(b"\n"))
            .and_then(|()| self.output.flush());
        if result.is_err() {
            self.exit_code = crate::protocol::EXIT_PROTOCOL;
            unsafe {
                PostQuitMessage(self.exit_code);
            }
        }
    }
}

enum NativeEvent {
    Supervisor(Incoming),
    Tray(u32),
    TaskbarCreated,
    Retry,
}

struct WindowContext {
    taskbar_created: u32,
    sender: Sender<NativeEvent>,
}

unsafe extern "system" fn window_proc(
    hwnd: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    let context = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *const WindowContext;
    if !context.is_null() {
        let context = &*context;
        if message == context.taskbar_created {
            if context.sender.send(NativeEvent::TaskbarCreated).is_err() {
                PostQuitMessage(EXIT_SHELL_UNAVAILABLE);
            }
            return 0;
        }
        match message {
            WM_SUPERVISOR => return 0,
            WM_TRAY_CALLBACK => {
                if context
                    .sender
                    .send(NativeEvent::Tray((lparam as u32) & 0xffff))
                    .is_err()
                {
                    PostQuitMessage(EXIT_SHELL_UNAVAILABLE);
                }
                return 0;
            }
            WM_TIMER if wparam == RETRY_TIMER_ID => {
                KillTimer(hwnd, RETRY_TIMER_ID);
                if context.sender.send(NativeEvent::Retry).is_err() {
                    PostQuitMessage(EXIT_SHELL_UNAVAILABLE);
                }
                return 0;
            }
            WM_DESTROY => {
                PostQuitMessage(0);
                return 0;
            }
            _ => {}
        }
    }
    DefWindowProcW(hwnd, message, wparam, lparam)
}

fn spawn_stdin_reader(hwnd: HWND, sender: Sender<NativeEvent>) {
    let hwnd = hwnd as isize;
    std::thread::spawn(move || {
        let hwnd = hwnd as HWND;
        let mut reader = LineReader::new(std::io::stdin().lock());
        loop {
            let message = match reader.read_line() {
                Ok(Some(line)) => parse_incoming_line(&line).unwrap_or(Incoming::ProtocolError),
                Ok(None) => Incoming::Exit,
                Err(_) => Incoming::ProtocolError,
            };
            let should_exit = matches!(message, Incoming::Exit | Incoming::ProtocolError);
            if sender.send(NativeEvent::Supervisor(message)).is_err() {
                break;
            }
            if unsafe { PostMessageW(hwnd, WM_SUPERVISOR, 0, 0) } == 0 {
                break;
            }
            if should_exit {
                break;
            }
        }
    });
}

fn now_ms() -> u64 {
    unsafe { GetTickCount64() }
}

fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(Some(0)).collect()
}
