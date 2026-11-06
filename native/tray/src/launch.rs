use crate::protocol::AppLaunch;
use std::ffi::c_void;
use std::io;
use std::ptr::{null, null_mut};
use windows_sys::Win32::Foundation::{CloseHandle, FALSE};
use windows_sys::Win32::System::Environment::{CreateEnvironmentBlock, DestroyEnvironmentBlock};
use windows_sys::Win32::System::Threading::{
    CreateProcessW, CREATE_UNICODE_ENVIRONMENT, PROCESS_INFORMATION, STARTUPINFOW,
};

pub fn launch(app: &AppLaunch) -> Result<(), String> {
    let application = wide(&app.exe);
    let cwd = wide(&app.cwd);
    let mut command = quote_arg(&app.exe);
    for argument in &app.args {
        command.push(' ');
        command.push_str(&quote_arg(argument));
    }
    let mut command = wide(&command);

    let mut environment = null_mut();
    if unsafe { CreateEnvironmentBlock(&mut environment, null_mut(), FALSE) } == FALSE {
        return Err(io::Error::last_os_error().to_string());
    }
    let environment = EnvironmentBlock(environment);

    let startup = STARTUPINFOW {
        cb: size_of::<STARTUPINFOW>() as u32,
        ..Default::default()
    };
    let mut process = PROCESS_INFORMATION::default();
    let created = unsafe {
        CreateProcessW(
            application.as_ptr(),
            command.as_mut_ptr(),
            null(),
            null(),
            FALSE,
            CREATE_UNICODE_ENVIRONMENT,
            environment.0,
            cwd.as_ptr(),
            &startup,
            &mut process,
        )
    };
    if created == FALSE {
        return Err(io::Error::last_os_error().to_string());
    }

    unsafe {
        CloseHandle(process.hThread);
        CloseHandle(process.hProcess);
    }
    Ok(())
}

struct EnvironmentBlock(*mut c_void);

impl Drop for EnvironmentBlock {
    fn drop(&mut self) {
        unsafe {
            DestroyEnvironmentBlock(self.0);
        }
    }
}

fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(Some(0)).collect()
}

fn quote_arg(argument: &str) -> String {
    if !argument.is_empty()
        && !argument
            .bytes()
            .any(|byte| byte == b' ' || byte == b'\t' || byte == b'"')
    {
        return argument.to_owned();
    }

    let mut quoted = String::from('"');
    let mut slashes = 0;
    for character in argument.chars() {
        if character == '\\' {
            slashes += 1;
        } else if character == '"' {
            quoted.push_str(&"\\".repeat(slashes * 2 + 1));
            quoted.push('"');
            slashes = 0;
        } else {
            quoted.push_str(&"\\".repeat(slashes));
            quoted.push(character);
            slashes = 0;
        }
    }
    quoted.push_str(&"\\".repeat(slashes * 2));
    quoted.push('"');
    quoted
}

#[cfg(test)]
mod tests {
    use super::quote_arg;

    #[test]
    fn quotes_windows_command_line_arguments() {
        assert_eq!(quote_arg("plain"), "plain");
        assert_eq!(quote_arg("two words"), "\"two words\"");
        assert_eq!(quote_arg("a\"b"), "\"a\\\"b\"");
        assert_eq!(
            quote_arg("C:\\trailing path\\"),
            "\"C:\\trailing path\\\\\""
        );
    }
}
