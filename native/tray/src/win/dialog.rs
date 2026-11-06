use crate::protocol::Confirm;
use std::ptr::null_mut;
use windows_sys::Win32::Foundation::HWND;
use windows_sys::Win32::UI::Controls::{
    TaskDialogIndirect, TASKDIALOGCONFIG, TASKDIALOG_BUTTON, TDCBF_OK_BUTTON,
    TDF_ALLOW_DIALOG_CANCELLATION, TDF_POSITION_RELATIVE_TO_WINDOW,
};
use windows_sys::Win32::UI::WindowsAndMessaging::{SetForegroundWindow, IDCANCEL};

const CONFIRM_ID: i32 = 100;

pub fn confirm(hwnd: HWND, copy: &Confirm) -> bool {
    let window_title = wide("Conduit");
    let title = wide(&copy.title);
    let body = wide(&copy.body);
    let confirm = wide(&copy.confirm);
    let cancel = wide(&copy.cancel);
    let buttons = [
        TASKDIALOG_BUTTON {
            nButtonID: CONFIRM_ID,
            pszButtonText: confirm.as_ptr(),
        },
        TASKDIALOG_BUTTON {
            nButtonID: IDCANCEL,
            pszButtonText: cancel.as_ptr(),
        },
    ];
    let config = TASKDIALOGCONFIG {
        cbSize: size_of::<TASKDIALOGCONFIG>() as u32,
        hwndParent: hwnd,
        dwFlags: TDF_ALLOW_DIALOG_CANCELLATION | TDF_POSITION_RELATIVE_TO_WINDOW,
        pszWindowTitle: window_title.as_ptr(),
        pszMainInstruction: title.as_ptr(),
        pszContent: body.as_ptr(),
        cButtons: buttons.len() as u32,
        pButtons: buttons.as_ptr(),
        nDefaultButton: IDCANCEL,
        ..Default::default()
    };
    let mut selected = IDCANCEL;
    unsafe {
        SetForegroundWindow(hwnd);
        TaskDialogIndirect(&config, &mut selected, null_mut(), null_mut());
    }
    selected == CONFIRM_ID
}

pub fn error(hwnd: HWND, title: &str, body: &str) {
    let window_title = wide("Conduit");
    let title = wide(title);
    let body = wide(body);
    let config = TASKDIALOGCONFIG {
        cbSize: size_of::<TASKDIALOGCONFIG>() as u32,
        hwndParent: hwnd,
        dwFlags: TDF_ALLOW_DIALOG_CANCELLATION | TDF_POSITION_RELATIVE_TO_WINDOW,
        dwCommonButtons: TDCBF_OK_BUTTON,
        pszWindowTitle: window_title.as_ptr(),
        pszMainInstruction: title.as_ptr(),
        pszContent: body.as_ptr(),
        ..Default::default()
    };
    unsafe {
        SetForegroundWindow(hwnd);
        TaskDialogIndirect(&config, null_mut(), null_mut(), null_mut());
    }
}

fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(Some(0)).collect()
}
