use serde::{Deserialize, Serialize};
use tauri::WebviewWindow;

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
pub struct Point {
    pub x: f64,
    pub y: f64,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl Rect {
    pub fn contains(self, point: Point) -> bool {
        point.x >= self.x
            && point.y >= self.y
            && point.x < self.x + self.width
            && point.y < self.y + self.height
    }

    pub fn validate(self) -> Result<(), String> {
        if [self.x, self.y, self.width, self.height]
            .iter()
            .all(|value| value.is_finite())
            && (1.0..=16384.0).contains(&self.width)
            && (1.0..=16384.0).contains(&self.height)
        {
            Ok(())
        } else {
            Err("Invalid desktop viewport bounds".into())
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Screen {
    pub name: String,
    pub frame: Rect,
    pub work_area: Rect,
    pub scale: f64,
}

#[derive(Clone, Debug, Serialize)]
pub struct Layout {
    pub screens: Vec<Screen>,
    pub viewport: Rect,
    #[serde(skip)]
    pub primary_top: f64,
}

// AppKit coordinates are logical points on every display, including mixed Retina/1x
// arrangements. Converting each display's physical origin independently is incorrect.
#[cfg(target_os = "macos")]
mod platform {
    use super::*;
    use objc2::MainThreadMarker;
    use objc2_app_kit::{NSEvent, NSScreen, NSWindow};
    use objc2_foundation::{NSPoint, NSRect, NSSize};

    fn screens() -> Result<objc2::rc::Retained<objc2_foundation::NSArray<NSScreen>>, String> {
        let main = MainThreadMarker::new().ok_or("Desktop geometry must run on the main thread")?;
        Ok(NSScreen::screens(main))
    }

    fn primary_top() -> Result<f64, String> {
        let screens = screens()?;
        let primary = screens.firstObject().ok_or("No displays are available")?;
        let frame = primary.frame();
        Ok(frame.origin.y + frame.size.height)
    }

    fn top_left(frame: NSRect, top: f64) -> Rect {
        Rect {
            x: frame.origin.x,
            y: top - frame.origin.y - frame.size.height,
            width: frame.size.width,
            height: frame.size.height,
        }
    }

    pub fn layout(window: &WebviewWindow) -> Result<Layout, String> {
        let screens = screens()?;
        let top = primary_top()?;
        let screens = screens
            .iter()
            .map(|screen| Screen {
                name: screen.localizedName().to_string(),
                frame: top_left(screen.frame(), top),
                work_area: top_left(screen.visibleFrame(), top),
                scale: screen.backingScaleFactor(),
            })
            .collect::<Vec<_>>();
        let pointer = window.ns_window().map_err(|e| e.to_string())?;
        // The window is owned by Tauri and these synchronous commands run on its main thread.
        let native = unsafe { &*pointer.cast::<NSWindow>() };
        Ok(Layout {
            screens,
            viewport: top_left(native.frame(), top),
            primary_top: top,
        })
    }

    pub fn cursor(top: f64) -> Result<Point, String> {
        let point = NSEvent::mouseLocation();
        Ok(Point {
            x: point.x,
            y: top - point.y,
        })
    }

    pub fn place(window: &WebviewWindow, bounds: Rect, top: f64) -> Result<Rect, String> {
        bounds.validate()?;
        let pointer = window.ns_window().map_err(|e| e.to_string())?;
        let native = unsafe { &*pointer.cast::<NSWindow>() };
        let frame = NSRect::new(
            NSPoint::new(bounds.x, top - bounds.y - bounds.height),
            NSSize::new(bounds.width, bounds.height),
        );
        if native.frame() != frame {
            native.setFrame_display(frame, true);
        }
        Ok(top_left(native.frame(), top))
    }

    pub fn set_level(window: &WebviewWindow, offset: Option<isize>) -> Result<(), String> {
        use objc2_app_kit::{NSNormalWindowLevel, NSStatusWindowLevel};
        let pointer = window.ns_window().map_err(|e| e.to_string())?;
        let native = unsafe { &*pointer.cast::<NSWindow>() };
        native.setLevel(offset.map_or(NSNormalWindowLevel, |offset| NSStatusWindowLevel + offset));
        Ok(())
    }
}

#[cfg(not(target_os = "macos"))]
mod platform {
    use super::*;

    pub fn layout(_window: &WebviewWindow) -> Result<Layout, String> {
        Err("Automatic cross-screen geometry is currently supported on macOS only".into())
    }

    pub fn cursor(_top: f64) -> Result<Point, String> {
        Err("Global logical cursor coordinates are currently supported on macOS only".into())
    }

    pub fn place(_window: &WebviewWindow, _bounds: Rect, _top: f64) -> Result<Rect, String> {
        Err("Automatic cross-screen positioning is currently supported on macOS only".into())
    }

    pub fn set_level(window: &WebviewWindow, offset: Option<isize>) -> Result<(), String> {
        window
            .set_always_on_top(offset.is_some())
            .map_err(|e| e.to_string())
    }
}

pub use platform::{cursor, layout, place, set_level};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn negative_desktop_origins_are_valid_and_rectangles_are_half_open() {
        let rect = Rect {
            x: -1920.0,
            y: -300.0,
            width: 1920.0,
            height: 1080.0,
        };
        assert!(rect.validate().is_ok());
        assert!(rect.contains(Point {
            x: -1920.0,
            y: -300.0
        }));
        assert!(!rect.contains(Point { x: 0.0, y: 0.0 }));
    }

    #[test]
    fn viewport_rejects_nonfinite_and_invalid_dimensions() {
        for rect in [
            Rect {
                x: f64::NAN,
                y: 0.0,
                width: 100.0,
                height: 100.0,
            },
            Rect {
                x: 0.0,
                y: 0.0,
                width: 0.0,
                height: 100.0,
            },
            Rect {
                x: 0.0,
                y: 0.0,
                width: 20000.0,
                height: 100.0,
            },
        ] {
            assert!(rect.validate().is_err());
        }
    }
}
