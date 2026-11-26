use serde::Serialize;

#[derive(Clone, Copy, Debug, Serialize)]
pub enum Language {
    #[serde(rename = "en")]
    English,
    #[serde(rename = "zh-CN")]
    SimplifiedChinese,
}

impl Language {
    pub fn system() -> Self {
        #[cfg(target_os = "macos")]
        {
            let preferred = objc2_foundation::NSLocale::preferredLanguages();
            if let Some(language) = preferred.firstObject() {
                let tag = language.to_string().to_ascii_lowercase();
                if tag == "zh" || tag.starts_with("zh-") || tag.starts_with("zh_") {
                    return Self::SimplifiedChinese;
                }
            }
        }
        #[cfg(target_os = "windows")]
        {
            #[link(name = "kernel32")]
            extern "system" { fn GetUserDefaultUILanguage() -> u16; }
            // The low ten bits of a LANGID identify its primary language.
            if unsafe { GetUserDefaultUILanguage() } & 0x03ff == 0x04 {
                return Self::SimplifiedChinese;
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
