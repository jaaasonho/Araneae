use crate::language::Language;
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    Roam,
    Follow,
    Observe,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub language: Language,
    pub platform: &'static str,
    pub mode: Mode,
    pub speed: f64,
    pub size: f64,
    pub paused: bool,
    pub feet: bool,
    pub dark: bool,
    pub visible: bool,
    pub whole_screen: bool,
    pub allow_cross_screen: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            language: Language::system(),
            platform: std::env::consts::OS,
            mode: Mode::Roam,
            speed: 1.25,
            size: 0.5,
            paused: false,
            feet: false,
            dark: false,
            visible: true,
            whole_screen: false,
            allow_cross_screen: true,
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", content = "value", rename_all = "camelCase")]
pub enum Command {
    Mode(Mode),
    Speed(f64),
    Size(f64),
    Paused(bool),
    Feet(bool),
    Dark(bool),
    Visible(bool),
    WholeScreen(bool),
    AllowCrossScreen(bool),
}

impl Settings {
    pub fn apply(&mut self, command: Command) -> Result<(), String> {
        match command {
            Command::Mode(value) => self.mode = value,
            Command::Speed(value) => self.speed = range(value, 0.35, 3.0)?,
            Command::Size(value) => self.size = range(value, 0.35, 2.1)?,
            Command::Paused(value) => self.paused = value,
            Command::Feet(value) => self.feet = value,
            Command::Dark(value) => self.dark = value,
            Command::Visible(value) => self.visible = value,
            Command::WholeScreen(value) => self.whole_screen = value,
            Command::AllowCrossScreen(value) => self.allow_cross_screen = value,
        }
        Ok(())
    }
}

fn range(value: f64, min: f64, max: f64) -> Result<f64, String> {
    if value.is_finite() && (min..=max).contains(&value) {
        Ok(value)
    } else {
        Err(format!("Value must be finite and between {min} and {max}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn invalid_values_do_not_change_settings() {
        let mut settings = Settings::default();
        for value in [f64::NAN, f64::INFINITY, -1.0, 3.01] {
            assert!(settings.apply(Command::Speed(value)).is_err());
            assert_eq!(settings.speed, 1.25);
        }
        assert!(settings.apply(Command::Size(2.11)).is_err());
        assert_eq!(settings.size, 0.5);
        for value in [0.35, 3.0] {
            settings.apply(Command::Speed(value)).unwrap();
            assert_eq!(settings.speed, value);
        }
        for value in [0.35, 2.1] {
            settings.apply(Command::Size(value)).unwrap();
            assert_eq!(settings.size, value);
        }
    }
}
