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
#[serde(rename_all = "camelCase")]
pub struct Layout {
    pub screens: Vec<Screen>,
    pub viewport: Rect,
    pub base_scale: f64,
    #[serde(skip)]
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    pub primary_top: f64,
}

#[cfg(any(target_os = "windows", test))]
pub fn physical_point_to_logical(x: i32, y: i32, scale: f64) -> Point {
    let scale = if scale.is_finite() && scale > 0.0 {
        scale
    } else {
        1.0
    };
    Point {
        x: f64::from(x) / scale,
        y: f64::from(y) / scale,
    }
}

#[cfg(any(target_os = "windows", test))]
pub fn physical_rect_to_logical(left: i32, top: i32, right: i32, bottom: i32, scale: f64) -> Rect {
    let scale = if scale.is_finite() && scale > 0.0 {
        scale
    } else {
        1.0
    };
    Rect {
        x: f64::from(left) / scale,
        y: f64::from(top) / scale,
        width: f64::from((right - left).max(1)) / scale,
        height: f64::from((bottom - top).max(1)) / scale,
    }
}

#[cfg(any(target_os = "windows", test))]
pub fn logical_rect_to_physical(bounds: Rect, scale: f64) -> (i32, i32, i32, i32) {
    let scale = if scale.is_finite() && scale > 0.0 {
        scale
    } else {
        1.0
    };
    let left = (bounds.x * scale).round() as i32;
    let top = (bounds.y * scale).round() as i32;
    let right = ((bounds.x + bounds.width) * scale).round() as i32;
    let bottom = ((bounds.y + bounds.height) * scale).round() as i32;
    (left, top, (right - left).max(1), (bottom - top).max(1))
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
            base_scale: 1.0,
            primary_top: top,
        })
    }

    pub fn cursor(layout: &Layout) -> Result<Point, String> {
        let point = NSEvent::mouseLocation();
        Ok(Point {
            x: point.x,
            y: layout.primary_top - point.y,
        })
    }

    pub fn place(window: &WebviewWindow, bounds: Rect, layout: &Layout) -> Result<Rect, String> {
        bounds.validate()?;
        let pointer = window.ns_window().map_err(|e| e.to_string())?;
        let native = unsafe { &*pointer.cast::<NSWindow>() };
        let frame = NSRect::new(
            NSPoint::new(bounds.x, layout.primary_top - bounds.y - bounds.height),
            NSSize::new(bounds.width, bounds.height),
        );
        if native.frame() != frame {
            native.setFrame_display(frame, true);
        }
        Ok(top_left(native.frame(), layout.primary_top))
    }

    fn apply_level(window: &WebviewWindow, offset: Option<isize>) -> Result<(), String> {
        use objc2_app_kit::{NSNormalWindowLevel, NSStatusWindowLevel};
        let pointer = window.ns_window().map_err(|e| e.to_string())?;
        let native = unsafe { &*pointer.cast::<NSWindow>() };
        native.setLevel(offset.map_or(NSNormalWindowLevel, |offset| NSStatusWindowLevel + offset));
        Ok(())
    }

    pub fn set_level(window: &WebviewWindow, offset: Option<isize>) -> Result<(), String> {
        if MainThreadMarker::new().is_some() {
            apply_level(window, offset)
        } else {
            let (tx, rx) = std::sync::mpsc::sync_channel(1);
            let target = window.clone();
            window
                .run_on_main_thread(move || {
                    let _ = tx.send(apply_level(&target, offset));
                })
                .map_err(|e| e.to_string())?;
            rx.recv()
                .map_err(|_| "Main thread stopped before updating window level".to_string())?
        }
    }
}

#[cfg(target_os = "windows")]
mod platform {
    use super::*;
    use std::mem::size_of;
    use windows_sys::core::BOOL;
    use windows_sys::Win32::{
        Foundation::{HWND, LPARAM, POINT, RECT, S_OK, TRUE},
        Graphics::Gdi::{
            EnumDisplayMonitors, GetMonitorInfoW, HDC, HMONITOR, MONITORINFO, MONITORINFOEXW,
        },
        UI::{
            HiDpi::{GetDpiForMonitor, MDT_EFFECTIVE_DPI},
            WindowsAndMessaging::{
                GetCursorPos, GetWindowRect, SetWindowPos, HWND_NOTOPMOST, HWND_TOPMOST,
                SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SWP_NOZORDER,
            },
        },
    };

    const MONITORINFOF_PRIMARY: u32 = 1;

    struct RawMonitor {
        name: String,
        frame: RECT,
        work_area: RECT,
        scale: f64,
        primary: bool,
    }

    unsafe extern "system" fn enum_monitor(
        monitor: HMONITOR,
        _hdc: HDC,
        _clip: *mut RECT,
        data: LPARAM,
    ) -> BOOL {
        let monitors = &mut *(data as *mut Vec<RawMonitor>);
        let mut info = MONITORINFOEXW {
            monitorInfo: MONITORINFO {
                cbSize: size_of::<MONITORINFOEXW>() as u32,
                rcMonitor: RECT {
                    left: 0,
                    top: 0,
                    right: 0,
                    bottom: 0,
                },
                rcWork: RECT {
                    left: 0,
                    top: 0,
                    right: 0,
                    bottom: 0,
                },
                dwFlags: 0,
            },
            szDevice: [0u16; 32],
        };
        if GetMonitorInfoW(monitor, (&mut info as *mut MONITORINFOEXW).cast()) == 0 {
            return TRUE;
        }
        let mut dpi_x: u32 = 96;
        let mut dpi_y: u32 = 96;
        let scale = if GetDpiForMonitor(monitor, MDT_EFFECTIVE_DPI, &mut dpi_x, &mut dpi_y) == S_OK
            && dpi_x > 0
        {
            f64::from(dpi_x) / 96.0
        } else {
            1.0
        };
        let end = info
            .szDevice
            .iter()
            .position(|&unit| unit == 0)
            .unwrap_or(info.szDevice.len());
        let name = String::from_utf16_lossy(&info.szDevice[..end]);
        monitors.push(RawMonitor {
            name: if name.is_empty() {
                format!("Display {}", monitors.len() + 1)
            } else {
                name
            },
            frame: info.monitorInfo.rcMonitor,
            work_area: info.monitorInfo.rcWork,
            scale,
            primary: (info.monitorInfo.dwFlags & MONITORINFOF_PRIMARY) != 0,
        });
        TRUE
    }

    fn hwnd(window: &WebviewWindow) -> Result<HWND, String> {
        let raw = window.hwnd().map_err(|e| e.to_string())?;
        Ok(raw.0 as HWND)
    }

    fn window_rect(hwnd: HWND) -> Result<RECT, String> {
        let mut rect = RECT {
            left: 0,
            top: 0,
            right: 0,
            bottom: 0,
        };
        if unsafe { GetWindowRect(hwnd, &mut rect) } == 0 {
            return Err("Could not query Windows viewport rectangle".into());
        }
        Ok(rect)
    }

    pub fn layout(window: &WebviewWindow) -> Result<Layout, String> {
        let mut monitors: Vec<RawMonitor> = Vec::new();
        let ok = unsafe {
            EnumDisplayMonitors(
                std::ptr::null_mut(),
                std::ptr::null(),
                Some(enum_monitor),
                (&mut monitors as *mut Vec<RawMonitor>) as LPARAM,
            )
        };
        if ok == 0 || monitors.is_empty() {
            return Err("No displays are available".into());
        }
        // Keep primary display first and divide all monitors by one shared base scale so
        // physical seams remain exact (< 1 logical unit) even under mixed-DPI setups.
        if let Some(primary_idx) = monitors.iter().position(|m| m.primary) {
            if primary_idx != 0 {
                monitors.swap(0, primary_idx);
            }
        }
        let base_scale = monitors[0].scale;
        let screens = monitors
            .into_iter()
            .map(|monitor| Screen {
                name: monitor.name,
                frame: physical_rect_to_logical(
                    monitor.frame.left,
                    monitor.frame.top,
                    monitor.frame.right,
                    monitor.frame.bottom,
                    base_scale,
                ),
                work_area: physical_rect_to_logical(
                    monitor.work_area.left,
                    monitor.work_area.top,
                    monitor.work_area.right,
                    monitor.work_area.bottom,
                    base_scale,
                ),
                scale: monitor.scale,
            })
            .collect::<Vec<_>>();
        let rect = window_rect(hwnd(window)?)?;
        Ok(Layout {
            screens,
            viewport: physical_rect_to_logical(
                rect.left,
                rect.top,
                rect.right,
                rect.bottom,
                base_scale,
            ),
            base_scale,
            primary_top: 0.0,
        })
    }

    pub fn cursor(layout: &Layout) -> Result<Point, String> {
        let mut point = POINT { x: 0, y: 0 };
        if unsafe { GetCursorPos(&mut point) } == 0 {
            return Err("Global cursor position is temporarily unavailable".into());
        }
        Ok(physical_point_to_logical(
            point.x,
            point.y,
            layout.base_scale,
        ))
    }

    pub fn place(window: &WebviewWindow, bounds: Rect, layout: &Layout) -> Result<Rect, String> {
        bounds.validate()?;
        let hwnd = hwnd(window)?;
        let (x, y, width, height) = logical_rect_to_physical(bounds, layout.base_scale);
        let current = window_rect(hwnd)?;
        if current.left != x
            || current.top != y
            || current.right - current.left != width
            || current.bottom - current.top != height
        {
            let ok = unsafe {
                SetWindowPos(
                    hwnd,
                    std::ptr::null_mut(),
                    x,
                    y,
                    width,
                    height,
                    SWP_NOACTIVATE | SWP_NOZORDER,
                )
            };
            if ok == 0 {
                return Err("Could not position Windows desktop viewport".into());
            }
        }
        let actual = window_rect(hwnd)?;
        Ok(physical_rect_to_logical(
            actual.left,
            actual.top,
            actual.right,
            actual.bottom,
            layout.base_scale,
        ))
    }

    pub fn set_level(window: &WebviewWindow, offset: Option<isize>) -> Result<(), String> {
        let hwnd = hwnd(window)?;
        let insert_after = if offset.is_some() {
            HWND_TOPMOST
        } else {
            HWND_NOTOPMOST
        };
        let ok = unsafe {
            SetWindowPos(
                hwnd,
                insert_after,
                0,
                0,
                0,
                0,
                SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
            )
        };
        if ok == 0 {
            return Err("Could not update Windows window z-order".into());
        }
        Ok(())
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
mod platform {
    use super::*;

    pub fn layout(_window: &WebviewWindow) -> Result<Layout, String> {
        Err(
            "Automatic cross-screen geometry is currently supported on macOS and Windows only"
                .into(),
        )
    }

    pub fn cursor(_layout: &Layout) -> Result<Point, String> {
        Err(
            "Global logical cursor coordinates are currently supported on macOS and Windows only"
                .into(),
        )
    }

    pub fn place(_window: &WebviewWindow, _bounds: Rect, _layout: &Layout) -> Result<Rect, String> {
        Err(
            "Automatic cross-screen positioning is currently supported on macOS and Windows only"
                .into(),
        )
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

    #[test]
    fn physical_and_logical_conversions_roundtrip_across_scales_and_negative_origins() {
        for scale in [1.0, 1.25, 1.5, 2.0] {
            let requested = Rect {
                x: -640.0,
                y: -120.0,
                width: 512.0,
                height: 448.0,
            };
            let (px, py, pw, ph) = logical_rect_to_physical(requested, scale);
            let roundtrip = physical_rect_to_logical(px, py, px + pw, py + ph, scale);
            assert!((roundtrip.x - requested.x).abs() <= 1.0 / scale + 1e-9);
            assert!((roundtrip.y - requested.y).abs() <= 1.0 / scale + 1e-9);
            assert!((roundtrip.width - requested.width).abs() <= 2.0 / scale + 1e-9);
            assert!((roundtrip.height - requested.height).abs() <= 2.0 / scale + 1e-9);
        }
    }

    #[test]
    fn mixed_dpi_shared_base_scale_preserves_exact_monitor_seams() {
        let base_scale = 1.5;
        let primary = physical_rect_to_logical(0, 0, 2560, 1440, base_scale);
        let left_secondary = physical_rect_to_logical(-1920, 180, 0, 1260, base_scale);
        let top_secondary = physical_rect_to_logical(300, -1080, 2220, 0, base_scale);
        assert!(((left_secondary.x + left_secondary.width) - primary.x).abs() < 1e-9);
        assert!(((top_secondary.y + top_secondary.height) - primary.y).abs() < 1e-9);
        let point = physical_point_to_logical(1500, 600, base_scale);
        assert!((point.x - 1000.0).abs() < 1e-9);
        assert!((point.y - 400.0).abs() < 1e-9);
    }
}
