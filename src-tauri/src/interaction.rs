#[cfg(target_os = "macos")]
mod platform {
    use crate::{desktop, DesktopResult};
    use block2::RcBlock;
    use objc2::{rc::Retained, runtime::AnyObject, MainThreadMarker};
    use objc2_app_kit::{NSEvent, NSEventMask, NSEventModifierFlags, NSEventType};
    use serde::Serialize;
    use std::{cell::RefCell, ptr::NonNull};
    use tauri::Emitter;

    thread_local! {
        // AppKit installs, invokes, and removes this monitor on the main thread.
        static MONITOR: RefCell<Option<Retained<AnyObject>>> = const { RefCell::new(None) };
    }

    #[derive(Clone, Serialize)]
    struct Destination {
        point: desktop::Point,
        fast: bool,
    }

    #[derive(Clone, Copy)]
    struct Press {
        point: desktop::Point,
    }

    fn handle(
        app: &tauri::AppHandle,
        event: &NSEvent,
        press: &RefCell<Option<Press>>,
    ) -> DesktopResult<()> {
        let settings = crate::settings(app)?;
        if !settings.visible || settings.paused {
            press.borrow_mut().take();
            return Ok(());
        }
        let main = MainThreadMarker::new().ok_or("Desktop clicks must run on the main thread")?;
        let layout = crate::cached_layout(app)?;
        // A global event normally has no local window. Preserve the actual event
        // location rather than sampling a cursor that may already have moved.
        let location = event.locationInWindow();
        let location = event
            .window(main)
            .map_or(location, |window| window.convertPointToScreen(location));
        let point = desktop::Point {
            x: location.x,
            y: layout.primary_top - location.y,
        };
        let in_work_area = point.x.is_finite()
            && point.y.is_finite()
            && layout
                .screens
                .iter()
                .any(|screen| screen.work_area.contains(point));
        if !in_work_area {
            press.borrow_mut().take();
            return Ok(());
        }
        match event.r#type() {
            NSEventType::LeftMouseDown => {
                *press.borrow_mut() = event
                    .modifierFlags()
                    .contains(NSEventModifierFlags::Command)
                    .then_some(Press { point });
            }
            NSEventType::LeftMouseDragged => {
                if press.borrow().is_some_and(|start| {
                    (point.x - start.point.x).hypot(point.y - start.point.y) > 5.0
                }) {
                    press.borrow_mut().take();
                }
            }
            NSEventType::LeftMouseUp => {
                let Some(start) = press.borrow_mut().take() else {
                    return Ok(());
                };
                if event
                    .modifierFlags()
                    .contains(NSEventModifierFlags::Command)
                    && (point.x - start.point.x).hypot(point.y - start.point.y) <= 5.0
                {
                    app.emit_to("pet", "pet-destination", Destination { point, fast: true })
                        .map_err(|error| error.to_string())?;
                }
            }
            _ => {}
        }
        Ok(())
    }

    pub fn start(app: &tauri::AppHandle) -> DesktopResult<()> {
        MainThreadMarker::new().ok_or("Desktop click monitor must start on the main thread")?;
        MONITOR.with(|slot| {
            if slot.borrow().is_some() {
                return Ok(());
            }
            let app = app.clone();
            let press = RefCell::new(None);
            let handler = RcBlock::new(move |event: NonNull<NSEvent>| {
                // AppKit keeps the event alive for the duration of this callback.
                if let Err(error) = handle(&app, unsafe { event.as_ref() }, &press) {
                    eprintln!("Desktop click handling failed: {error}");
                    if let Err(report_error) = app.emit_to("controls", "desktop-error", &error) {
                        eprintln!("Could not report desktop click error: {report_error}");
                    }
                }
            });
            // Global monitors receive copies of other apps' events and cannot
            // consume them. Our controls and menu clicks are excluded by AppKit.
            let monitor = NSEvent::addGlobalMonitorForEventsMatchingMask_handler(
                NSEventMask::LeftMouseDown
                    | NSEventMask::LeftMouseUp
                    | NSEventMask::LeftMouseDragged,
                &handler,
            )
            .ok_or("Could not install desktop click monitor")?;
            *slot.borrow_mut() = Some(monitor);
            Ok(())
        })
    }

    pub fn stop() -> DesktopResult<()> {
        MainThreadMarker::new().ok_or("Desktop click monitor must stop on the main thread")?;
        MONITOR.with(|slot| {
            if let Some(monitor) = slot.borrow_mut().take() {
                // This token was returned by addGlobalMonitor and is removed once.
                unsafe { NSEvent::removeMonitor(&monitor) };
            }
        });
        Ok(())
    }
}

#[cfg(target_os = "windows")]
mod platform {
    use crate::{desktop, DesktopResult};
    use std::{sync::atomic::{AtomicBool, Ordering}, time::Duration};
    use tauri::Emitter;

    #[link(name = "user32")]
    extern "system" { fn GetAsyncKeyState(key: i32) -> i16; }

    static STOP: AtomicBool = AtomicBool::new(false);

    #[derive(Clone, serde::Serialize)]
    struct Destination { point: desktop::Point, fast: bool }

    pub fn start(app: &tauri::AppHandle) -> DesktopResult<()> {
        let app = app.clone();
        std::thread::Builder::new().name("destination-click".into()).spawn(move || {
            let mut down = false;
            let mut start: Option<desktop::Point> = None;
            while !STOP.load(Ordering::Relaxed) {
                let pressed = unsafe { GetAsyncKeyState(1) } < 0;
                let ctrl = unsafe { GetAsyncKeyState(0x11) } < 0;
                if !ctrl {
                    start = None;
                } else if pressed || down {
                    if let Ok(point) = desktop::cursor(0.0) {
                        if pressed && !down {
                            start = Some(point);
                        }
                        if start.is_some_and(|p| (p.x - point.x).hypot(p.y - point.y) > 5.0) {
                            start = None;
                        }
                        if !pressed && start.take().is_some()
                            && crate::settings(&app).is_ok_and(|s| s.visible && !s.paused)
                            && crate::cached_layout(&app).is_ok_and(|l| l.screens.iter().any(|s| s.work_area.contains(point))) {
                            let _ = app.emit_to("pet", "pet-destination", Destination { point, fast: true });
                        }
                    } else {
                        start = None;
                    }
                }
                down = pressed;
                std::thread::sleep(Duration::from_millis(16));
            }
        }).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn stop() -> DesktopResult<()> {
        STOP.store(true, Ordering::Relaxed);
        Ok(())
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
mod platform {
    use crate::DesktopResult;

    pub fn start(_app: &tauri::AppHandle) -> DesktopResult<()> {
        Err("Passive desktop clicks are currently supported on macOS only".into())
    }

    pub fn stop() -> DesktopResult<()> {
        Ok(())
    }
}

pub use platform::{start, stop};
