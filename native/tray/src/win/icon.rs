use crate::protocol::{TrayIcon, TrayView};
use std::ptr::null;
use windows_sys::Win32::Foundation::{FALSE, HWND};
use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
use windows_sys::Win32::UI::Shell::{
    Shell_NotifyIconW, NIF_ICON, NIF_MESSAGE, NIF_SHOWTIP, NIF_TIP, NIM_ADD, NIM_DELETE,
    NIM_MODIFY, NIM_SETVERSION, NOTIFYICONDATAW, NOTIFYICON_VERSION_4,
};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    DestroyIcon, GetSystemMetrics, LoadImageW, IMAGE_ICON, LR_DEFAULTCOLOR, SM_CXSMICON,
    SM_CYSMICON,
};

const ICON_ID: u32 = 1;

pub struct TrayIconHost {
    hwnd: HWND,
    callback_message: u32,
    added: bool,
}

impl TrayIconHost {
    pub fn new(hwnd: HWND, callback_message: u32) -> Self {
        Self {
            hwnd,
            callback_message,
            added: false,
        }
    }

    pub fn show(&mut self, view: &TrayView) -> bool {
        // LR_DEFAULTSIZE takes the 32px image and the shell downscales it; the small-icon
        // metrics follow the taskbar DPI so the closest of 16/32/48 is used as-is.
        let icon = unsafe {
            LoadImageW(
                GetModuleHandleW(null()),
                resource(icon_resource(view.icon)),
                IMAGE_ICON,
                GetSystemMetrics(SM_CXSMICON),
                GetSystemMetrics(SM_CYSMICON),
                LR_DEFAULTCOLOR,
            )
        };
        if icon.is_null() {
            return false;
        }

        let mut data = self.data();
        data.uFlags = NIF_ICON | NIF_MESSAGE | NIF_TIP | NIF_SHOWTIP;
        data.uCallbackMessage = self.callback_message;
        data.hIcon = icon;
        copy_wide(&view.tooltip, &mut data.szTip);
        let operation = if self.added { NIM_MODIFY } else { NIM_ADD };
        let ok = unsafe { Shell_NotifyIconW(operation, &data) } != FALSE;
        if ok && !self.added {
            data.uFlags = 0;
            data.Anonymous.uVersion = NOTIFYICON_VERSION_4;
            self.added = unsafe { Shell_NotifyIconW(NIM_SETVERSION, &data) } != FALSE;
            if !self.added {
                unsafe {
                    Shell_NotifyIconW(NIM_DELETE, &data);
                }
            }
        }
        unsafe {
            DestroyIcon(icon);
        }
        ok && self.added
    }

    pub fn hide(&mut self) {
        if self.added {
            unsafe {
                Shell_NotifyIconW(NIM_DELETE, &self.data());
            }
            self.added = false;
        }
    }

    pub fn taskbar_recreated(&mut self) {
        self.added = false;
    }

    fn data(&self) -> NOTIFYICONDATAW {
        NOTIFYICONDATAW {
            cbSize: size_of::<NOTIFYICONDATAW>() as u32,
            hWnd: self.hwnd,
            uID: ICON_ID,
            ..Default::default()
        }
    }
}

impl Drop for TrayIconHost {
    fn drop(&mut self) {
        self.hide();
    }
}

/// One image per state: the icon is a full-colour mark that reads on light and dark taskbars alike.
fn icon_resource(icon: TrayIcon) -> u16 {
    match icon {
        TrayIcon::Normal => 101,
        TrayIcon::NeedsYou => 102,
        TrayIcon::Warning => 103,
    }
}

fn resource(id: u16) -> *const u16 {
    usize::from(id) as *const u16
}

fn copy_wide<const N: usize>(value: &str, target: &mut [u16; N]) {
    for (slot, unit) in target.iter_mut().zip(value.encode_utf16()) {
        *slot = unit;
    }
}
