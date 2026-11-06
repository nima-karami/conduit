use crate::protocol::{TrayIcon, TrayView};
use std::ffi::c_void;
use std::ptr::{null, null_mut};
use windows_sys::Win32::Foundation::{FALSE, HWND};
use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
use windows_sys::Win32::System::Registry::{RegGetValueW, HKEY_CURRENT_USER, RRF_RT_REG_DWORD};
use windows_sys::Win32::UI::Shell::{
    Shell_NotifyIconW, NIF_ICON, NIF_MESSAGE, NIF_SHOWTIP, NIF_TIP, NIM_ADD, NIM_DELETE,
    NIM_MODIFY, NIM_SETVERSION, NOTIFYICONDATAW, NOTIFYICON_VERSION_4,
};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    DestroyIcon, LoadImageW, IMAGE_ICON, LR_DEFAULTSIZE,
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
        let icon = unsafe {
            LoadImageW(
                GetModuleHandleW(null()),
                resource(icon_resource(view.icon)),
                IMAGE_ICON,
                0,
                0,
                LR_DEFAULTSIZE,
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

fn icon_resource(icon: TrayIcon) -> u16 {
    let light = system_uses_light_theme();
    match (icon, light) {
        (TrayIcon::Normal, true) => 101,
        (TrayIcon::NeedsYou, true) => 102,
        (TrayIcon::Warning, true) => 103,
        (TrayIcon::Normal, false) => 104,
        (TrayIcon::NeedsYou, false) => 105,
        (TrayIcon::Warning, false) => 106,
    }
}

fn system_uses_light_theme() -> bool {
    let subkey = wide("Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize");
    let value_name = wide("SystemUsesLightTheme");
    let mut value = 0_u32;
    let mut size = size_of::<u32>() as u32;
    let status = unsafe {
        RegGetValueW(
            HKEY_CURRENT_USER,
            subkey.as_ptr(),
            value_name.as_ptr(),
            RRF_RT_REG_DWORD,
            null_mut(),
            (&mut value as *mut u32).cast::<c_void>(),
            &mut size,
        )
    };
    status == 0 && value != 0
}

fn resource(id: u16) -> *const u16 {
    usize::from(id) as *const u16
}

fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(Some(0)).collect()
}

fn copy_wide<const N: usize>(value: &str, target: &mut [u16; N]) {
    for (slot, unit) in target.iter_mut().zip(value.encode_utf16()) {
        *slot = unit;
    }
}
