use crate::model::MenuAction;
use crate::protocol::{ActionId, TrayItem, TrayView};
use std::ptr::null;
use windows_sys::Win32::Foundation::{HWND, POINT};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    AppendMenuW, CreatePopupMenu, DestroyMenu, GetCursorPos, PostMessageW, SetForegroundWindow,
    SetMenuDefaultItem, TrackPopupMenuEx, MF_DISABLED, MF_GRAYED, MF_SEPARATOR, MF_STRING,
    TPM_NONOTIFY, TPM_RETURNCMD, TPM_RIGHTBUTTON, WM_NULL,
};

const OPEN_ID: usize = 1_001;
const STOP_ALL_ID: usize = 1_002;

pub fn show(hwnd: HWND, view: &TrayView) -> Option<MenuAction> {
    let menu = unsafe { CreatePopupMenu() };
    if menu.is_null() {
        return None;
    }

    for item in &view.items {
        match item {
            TrayItem::Label { text } => {
                append_text(menu, MF_STRING | MF_DISABLED | MF_GRAYED, 0, text);
            }
            TrayItem::Separator => unsafe {
                AppendMenuW(menu, MF_SEPARATOR, 0, null());
            },
            TrayItem::Action {
                id,
                text,
                enabled,
                is_default,
            } => {
                let command = match id {
                    ActionId::Open => OPEN_ID,
                    ActionId::StopAll => STOP_ALL_ID,
                };
                let flags = if *enabled {
                    MF_STRING
                } else {
                    MF_STRING | MF_DISABLED | MF_GRAYED
                };
                append_text(menu, flags, command, text);
                if *is_default {
                    unsafe {
                        SetMenuDefaultItem(menu, command as u32, 0);
                    }
                }
            }
        }
    }

    let mut point = POINT::default();
    unsafe {
        GetCursorPos(&mut point);
        SetForegroundWindow(hwnd);
    }
    let command = unsafe {
        TrackPopupMenuEx(
            menu,
            TPM_RETURNCMD | TPM_NONOTIFY | TPM_RIGHTBUTTON,
            point.x,
            point.y,
            hwnd,
            null(),
        )
    };
    unsafe {
        DestroyMenu(menu);
        PostMessageW(hwnd, WM_NULL, 0, 0);
    }

    match command as usize {
        OPEN_ID => Some(MenuAction::Open),
        STOP_ALL_ID => Some(MenuAction::StopAll),
        _ => None,
    }
}

fn append_text(
    menu: windows_sys::Win32::UI::WindowsAndMessaging::HMENU,
    flags: u32,
    id: usize,
    text: &str,
) {
    let text = wide(text);
    unsafe {
        AppendMenuW(menu, flags, id, text.as_ptr());
    }
}

fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(Some(0)).collect()
}
