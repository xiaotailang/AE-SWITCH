use crate::error::{AppError, Result};
use std::{path::Path, process::Command};

pub fn open_directory(directory: &Path) -> Result<()> {
    #[cfg(windows)]
    let mut command = {
        let mut command = Command::new("explorer.exe");
        command.arg(directory);
        command
    };
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    let mut command = unix_open_command(std::env::consts::OS, directory.as_os_str())?;
    #[cfg(any(windows, target_os = "macos", target_os = "linux"))]
    {
        command
            .spawn()
            .map_err(|_| AppError::new("open_directory", "无法打开便携目录"))?;
        Ok(())
    }
    #[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
    {
        let _ = directory;
        Err(AppError::new(
            "open_directory",
            "当前平台暂不支持打开便携目录",
        ))
    }
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
pub(crate) fn open_url(url: &str, code: &'static str, message: &str) -> Result<()> {
    unix_open_command(std::env::consts::OS, std::ffi::OsStr::new(url))?
        .spawn()
        .map_err(|_| AppError::new(code, message))?;
    Ok(())
}

#[cfg(any(target_os = "macos", target_os = "linux", test))]
fn unix_open_command(platform: &str, target: &std::ffi::OsStr) -> Result<Command> {
    let program = match platform {
        "macos" => "open",
        "linux" => "xdg-open",
        _ => {
            return Err(AppError::new(
                "open_unsupported",
                "当前平台暂不支持系统打开操作",
            ))
        }
    };
    let mut command = Command::new(program);
    if platform == "macos" {
        command.arg("--");
    }
    command.arg(target);
    Ok(command)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::{OsStr, OsString};

    #[test]
    fn system_openers_pass_a_directory_as_one_argument_without_a_shell() {
        let target = OsStr::new("/portable folder 中文/$(touch marker); other");
        for (platform, program, arguments) in [
            (
                "macos",
                "open",
                vec![OsString::from("--"), target.to_owned()],
            ),
            ("linux", "xdg-open", vec![target.to_owned()]),
        ] {
            let command = unix_open_command(platform, target).unwrap();
            assert_eq!(command.get_program(), program);
            assert_eq!(
                command.get_args().map(OsStr::to_owned).collect::<Vec<_>>(),
                arguments
            );
        }
    }

    #[test]
    fn fixed_project_and_service_urls_are_not_shell_arguments() {
        let urls = [
            crate::project_links::ProjectPage::Source.url(),
            crate::project_links::ProjectPage::License.url(),
            crate::project_links::ProjectPage::Tutorial.url(),
        ]
        .into_iter()
        .filter_map(std::result::Result::ok)
        .chain(std::iter::once(
            crate::service_website::SERVICE_WEBSITE.to_owned(),
        ));
        for url in urls {
            assert!(url.starts_with("https://"));
            for platform in ["macos", "linux"] {
                let command = unix_open_command(platform, OsStr::new(&url)).unwrap();
                assert_eq!(command.get_args().last(), Some(OsStr::new(&url)));
                assert_eq!(
                    command.get_args().count(),
                    if platform == "macos" { 2 } else { 1 }
                );
            }
        }
    }

    #[test]
    fn unsupported_platforms_do_not_create_an_opener_command() {
        assert_eq!(
            unix_open_command("other", OsStr::new("https://example.test/"))
                .unwrap_err()
                .code,
            "open_unsupported"
        );
    }
}
