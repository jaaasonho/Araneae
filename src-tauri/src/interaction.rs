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

#[cfg(target_os = "windows")]
#[path = "interaction_windows.rs"]
mod platform;

pub use platform::{start, stop};
