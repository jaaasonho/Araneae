use serde::Serialize;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub enum Language {
    #[serde(rename = "en")]
    English,
    #[serde(rename = "zh-CN")]
    SimplifiedChinese,
}

impl Language {
    pub fn from_tag(tag: &str) -> Self {
        let normalized = tag.trim().to_ascii_lowercase();
        if normalized == "zh" || normalized.starts_with("zh-") || normalized.starts_with("zh_") {
            Self::SimplifiedChinese
        } else {
            Self::English
        }
    }

    pub fn system() -> Self {
        #[cfg(target_os = "macos")]
        {
            let preferred = objc2_foundation::NSLocale::preferredLanguages();
            if let Some(language) = preferred.firstObject() {
                return Self::from_tag(&language.to_string());
            }
        }
        #[cfg(target_os = "windows")]
        {
            if let Some(tag) = windows_preferred_language() {
                return Self::from_tag(&tag);
            }
        }
        Self::English
    }

    pub fn text(self, english: &'static str, chinese: &'static str) -> &'static str {
        match self {
            Self::English => english,
            Self::SimplifiedChinese => chinese,
        }
    }
}

#[cfg(target_os = "windows")]
fn windows_preferred_language() -> Option<String> {
    use windows_sys::Win32::Globalization::{GetUserPreferredUILanguages, MUI_LANGUAGE_NAME};
    let mut count: u32 = 0;
    let mut buffer_len: u32 = 0;
    // Query required UTF-16 buffer length for BCP-47 display language names.
    let ok = unsafe {
        GetUserPreferredUILanguages(
            MUI_LANGUAGE_NAME,
            &mut count,
            std::ptr::null_mut(),
            &mut buffer_len,
        )
    };
    if ok == 0 || buffer_len == 0 {
        return None;
    }
    let mut buffer = vec![0u16; buffer_len as usize];
    let ok = unsafe {
        GetUserPreferredUILanguages(
            MUI_LANGUAGE_NAME,
            &mut count,
            buffer.as_mut_ptr(),
            &mut buffer_len,
        )
    };
    if ok == 0 {
        return None;
    }
    let end = buffer
        .iter()
        .position(|&unit| unit == 0)
        .unwrap_or(buffer.len());
    if end == 0 {
        return None;
    }
    Some(String::from_utf16_lossy(&buffer[..end]))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_chinese_and_non_chinese_language_tags() {
        for tag in [
            "zh",
            "zh-CN",
            "zh-Hans-CN",
            "zh-TW",
            "zh_CN",
            "ZH-hk",
            " zh-CN ",
        ] {
            assert_eq!(
                Language::from_tag(tag),
                Language::SimplifiedChinese,
                "tag={tag}"
            );
        }
        for tag in ["", "en", "en-US", "ja-JP", "zhx-CN"] {
            assert_eq!(Language::from_tag(tag), Language::English, "tag={tag}");
        }
    }
}
