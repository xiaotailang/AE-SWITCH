use crate::error::{AppError, Result};
use serde::Deserialize;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProjectPage {
    Source,
    License,
    Tutorial,
}

impl ProjectPage {
    pub fn url(&self) -> Result<String> {
        self.url_for(crate::updates::configured_repository().as_deref())
    }

    fn url_for(&self, repository: Option<&str>) -> Result<String> {
        let repository = repository
            .filter(|value| crate::updates::valid_repository(value))
            .ok_or_else(|| {
                AppError::new(
                    "project_repository_unconfigured",
                    "项目仓库尚未设置，请阅读内置教程和随包源码、许可",
                )
            })?;
        let source = format!("https://github.com/{repository}");
        Ok(match self {
            Self::Source => source,
            Self::Tutorial => format!("{source}/blob/main/app/docs/tutorial.md"),
            Self::License => format!("{source}/blob/main/app/LICENSE"),
        })
    }
}

/// Only build-configured project destinations are accepted; no supplier data is transmitted.
pub fn open(page: ProjectPage) -> Result<()> {
    let url = page.url()?;
    #[cfg(feature = "qa-webview")]
    if let Some(marker) = std::env::var_os("UNI_SWITCH_QA_PROJECT_OPEN_MARKER") {
        std::fs::write(marker, &url)
            .map_err(|_| AppError::new("project_open", "项目链接记录未完成"))?;
        return Ok(());
    }
    #[cfg(windows)]
    {
        use windows_sys::Win32::UI::{Shell::ShellExecuteW, WindowsAndMessaging::SW_SHOWNORMAL};
        let operation: Vec<u16> = "open\0".encode_utf16().collect();
        let target: Vec<u16> = url.encode_utf16().chain(Some(0)).collect();
        let result = unsafe {
            ShellExecuteW(
                std::ptr::null_mut(),
                operation.as_ptr(),
                target.as_ptr(),
                std::ptr::null(),
                std::ptr::null(),
                SW_SHOWNORMAL,
            )
        };
        if result as isize <= 32 {
            return Err(AppError::new(
                "project_open",
                "未能打开浏览器，请手动访问项目页面",
            ));
        }
        Ok(())
    }
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    {
        crate::desktop_platform::open_url(
            &url,
            "project_open",
            "未能打开浏览器，请手动访问项目页面",
        )
    }
    #[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
    {
        let _ = url;
        Err(AppError::new(
            "project_open",
            "请手动在浏览器中打开项目页面",
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_or_invalid_repository_never_falls_back_to_upstream() {
        for repository in [
            None,
            Some(""),
            Some("https://github.com/example/project"),
            Some("../project"),
            Some("owner/repo?key=secret"),
        ] {
            for page in [
                ProjectPage::Source,
                ProjectPage::License,
                ProjectPage::Tutorial,
            ] {
                assert_eq!(
                    page.url_for(repository).unwrap_err().code,
                    "project_repository_unconfigured"
                );
            }
        }
    }

    #[test]
    fn configured_links_point_to_this_workspace_layout() {
        let repository = Some("example/ae-switch");
        assert_eq!(
            ProjectPage::Source.url_for(repository).unwrap(),
            "https://github.com/example/ae-switch"
        );
        assert_eq!(
            ProjectPage::License.url_for(repository).unwrap(),
            "https://github.com/example/ae-switch/blob/main/app/LICENSE"
        );
        assert_eq!(
            ProjectPage::Tutorial.url_for(repository).unwrap(),
            "https://github.com/example/ae-switch/blob/main/app/docs/tutorial.md"
        );
    }
}
