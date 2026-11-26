use super::*;
use windows_sys::Win32::{
    Foundation::{POINT, RECT},
    UI::WindowsAndMessaging::{
        GetCursorPos, GetWindowRect, SetWindowPos, SWP_NOACTIVATE, SWP_NOOWNERZORDER, SWP_NOZORDER,
    },
};

fn viewport(window: &WebviewWindow, scale: f64) -> Result<Rect, String> {
    let hwnd = window.hwnd().map_err(|e| e.to_string())?.0;
    let mut rect = RECT::default();
    // The pet has no decorations: its client and outer rectangles coincide.
    if unsafe { GetWindowRect(hwnd, &mut rect) } == 0 {
        return Err(std::io::Error::last_os_error().to_string());
    }
    Ok(Rect {
        x: rect.left as f64 / scale,
        y: rect.top as f64 / scale,
        width: (rect.right - rect.left) as f64 / scale,
        height: (rect.bottom - rect.top) as f64 / scale,
    })
}

pub fn layout(window: &WebviewWindow) -> Result<Layout, String> {
    let primary = window
        .primary_monitor()
        .map_err(|e| e.to_string())?
        .ok_or("No primary display is available")?;
    // One desktop-wide scale preserves adjacency and negative origins. Dividing
    // each monitor's origin by its own DPI would introduce gaps and overlaps.
    let coordinate_scale = primary.scale_factor();
    let screens = window
        .available_monitors()
        .map_err(|e| e.to_string())?
        .iter()
        .map(|monitor| {
            let position = monitor.position();
            let size = monitor.size();
            let work = monitor.work_area();
            Screen {
                name: monitor.name().cloned().unwrap_or_else(|| "Display".into()),
                frame: Rect {
                    x: position.x as f64 / coordinate_scale,
                    y: position.y as f64 / coordinate_scale,
                    width: size.width as f64 / coordinate_scale,
                    height: size.height as f64 / coordinate_scale,
                },
                work_area: Rect {
                    x: work.position.x as f64 / coordinate_scale,
                    y: work.position.y as f64 / coordinate_scale,
                    width: work.size.width as f64 / coordinate_scale,
                    height: work.size.height as f64 / coordinate_scale,
                },
                scale: monitor.scale_factor(),
            }
        })
        .collect();
    Ok(Layout {
        screens,
        viewport: viewport(window, coordinate_scale)?,
        coordinate_scale,
        primary_top: 0.0,
    })
}

pub fn cursor(_top: f64, scale: f64) -> Result<Point, String> {
    let mut point = POINT::default();
    if unsafe { GetCursorPos(&mut point) } == 0 {
        return Err(std::io::Error::last_os_error().to_string());
    }
    Ok(Point {
        x: point.x as f64 / scale,
        y: point.y as f64 / scale,
    })
}

pub fn place(window: &WebviewWindow, bounds: Rect, _top: f64, scale: f64) -> Result<Rect, String> {
    bounds.validate()?;
    let hwnd = window.hwnd().map_err(|e| e.to_string())?.0;
    // Move and resize atomically, without activating the pet or stealing focus.
    if unsafe {
        SetWindowPos(
            hwnd,
            std::ptr::null_mut(),
            (bounds.x * scale).round() as i32,
            (bounds.y * scale).round() as i32,
            (bounds.width * scale).round() as i32,
            (bounds.height * scale).round() as i32,
            SWP_NOACTIVATE | SWP_NOOWNERZORDER | SWP_NOZORDER,
        )
    } == 0
    {
        return Err(std::io::Error::last_os_error().to_string());
    }
    viewport(window, scale)
}

pub fn set_level(window: &WebviewWindow, offset: Option<isize>) -> Result<(), String> {
    window
        .set_always_on_top(offset.is_some())
        .map_err(|e| e.to_string())
}
