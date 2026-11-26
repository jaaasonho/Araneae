use crate::{
    click::{ClickTracker, MouseAction},
    desktop, DesktopResult,
};
use serde::Serialize;
use std::{
    cell::RefCell,
    sync::{mpsc, Mutex},
    thread::JoinHandle,
};
use tauri::Emitter;
use windows_sys::Win32::{
    Foundation::{LPARAM, LRESULT, WPARAM},
    System::{
        LibraryLoader::GetModuleHandleW,
        Threading::{GetCurrentProcessId, GetCurrentThreadId},
    },
    UI::{
        HiDpi::{
            GetDpiForSystem, SetThreadDpiAwarenessContext,
            DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
        },
        Input::KeyboardAndMouse::{GetAsyncKeyState, VK_CONTROL},
        WindowsAndMessaging::*,
    },
};

struct CallbackState {
    clicks: ClickTracker,
    sender: mpsc::SyncSender<(i32, i32)>,
    tolerance: f64,
}
thread_local! {
    static CALLBACK: RefCell<Option<CallbackState>> = const { RefCell::new(None) };
}
struct Monitor {
    thread_id: u32,
    hook: JoinHandle<()>,
    dispatch: JoinHandle<()>,
}
static MONITOR: Mutex<Option<Monitor>> = Mutex::new(None);

#[derive(Clone, Serialize)]
struct Destination {
    point: desktop::Point,
    fast: bool,
}

unsafe extern "system" fn mouse_proc(code: i32, message: WPARAM, data: LPARAM) -> LRESULT {
    if code >= 0 {
        let action = match message as u32 {
            WM_LBUTTONDOWN => Some(MouseAction::Down),
            WM_MOUSEMOVE => Some(MouseAction::Move),
            WM_LBUTTONUP => Some(MouseAction::Up),
            _ => None,
        };
        if let Some(action) = action {
            // Windows owns this pointer until the hook returns. Do no IPC, window
            // mutation, or blocking work here: slow hooks can be silently removed.
            let event = unsafe { &*(data as *const MSLLHOOKSTRUCT) };
            let control = unsafe { GetAsyncKeyState(VK_CONTROL as i32) } < 0;
            let mut process = 0;
            unsafe {
                GetWindowThreadProcessId(
                    GetAncestor(WindowFromPoint(event.pt), GA_ROOT),
                    &mut process,
                );
            }
            let allowed =
                event.flags & LLMHF_INJECTED == 0 && process != unsafe { GetCurrentProcessId() };
            CALLBACK.with(|slot| {
                if let Some(state) = slot.borrow_mut().as_mut() {
                    if state.clicks.update(
                        action,
                        event.pt.x as f64,
                        event.pt.y as f64,
                        control,
                        allowed,
                        state.tolerance,
                    ) {
                        // A full queue drops a command rather than blocking mouse input.
                        let _ = state.sender.try_send((event.pt.x, event.pt.y));
                    }
                }
            });
        }
    }
    // Always preserve the original input and the other applications' hooks.
    unsafe { CallNextHookEx(std::ptr::null_mut(), code, message, data) }
}

fn deliver(app: &tauri::AppHandle, x: i32, y: i32) -> DesktopResult<()> {
    let settings = crate::settings(app)?;
    if !settings.visible || settings.paused {
        return Ok(());
    }
    let layout = crate::cached_layout(app)?;
    let point = desktop::Point {
        x: x as f64 / layout.coordinate_scale,
        y: y as f64 / layout.coordinate_scale,
    };
    if layout
        .screens
        .iter()
        .any(|screen| screen.work_area.contains(point))
    {
        app.emit_to("pet", "pet-destination", Destination { point, fast: true })
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub fn start(app: &tauri::AppHandle) -> DesktopResult<()> {
    let mut monitor = MONITOR.lock().map_err(|e| e.to_string())?;
    if monitor.is_some() {
        return Ok(());
    }
    let (sender, receiver) = mpsc::sync_channel(32);
    let (ready_sender, ready_receiver) = mpsc::sync_channel(1);
    let hook = std::thread::spawn(move || {
        // Keep hook event coordinates physical on mixed-DPI desktops.
        unsafe {
            SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
        }
        let mut message = MSG::default();
        unsafe {
            PeekMessageW(&mut message, std::ptr::null_mut(), 0, 0, PM_NOREMOVE);
        }
        let tolerance = 5.0 * unsafe { GetDpiForSystem() } as f64 / 96.0;
        CALLBACK.with(|slot| {
            *slot.borrow_mut() = Some(CallbackState {
                clicks: ClickTracker::default(),
                sender,
                tolerance,
            })
        });
        let handle = unsafe {
            SetWindowsHookExW(
                WH_MOUSE_LL,
                Some(mouse_proc),
                GetModuleHandleW(std::ptr::null()),
                0,
            )
        };
        if handle.is_null() {
            let _ = ready_sender.send(Err(std::io::Error::last_os_error().to_string()));
        } else {
            let _ = ready_sender.send(Ok(unsafe { GetCurrentThreadId() }));
            loop {
                let result = unsafe { GetMessageW(&mut message, std::ptr::null_mut(), 0, 0) };
                if result <= 0 {
                    if result < 0 {
                        eprintln!(
                            "Desktop mouse message loop failed: {}",
                            std::io::Error::last_os_error()
                        );
                    }
                    break;
                }
                unsafe {
                    TranslateMessage(&message);
                    DispatchMessageW(&message);
                }
            }
            if unsafe { UnhookWindowsHookEx(handle) } == 0 {
                eprintln!(
                    "Could not remove desktop mouse hook: {}",
                    std::io::Error::last_os_error()
                );
            }
        }
        CALLBACK.with(|slot| {
            slot.borrow_mut().take();
        });
    });
    let thread_id = match ready_receiver.recv() {
        Ok(Ok(id)) => id,
        result => {
            let _ = hook.join();
            return Err(match result {
                Ok(Err(error)) => error,
                _ => "Desktop mouse hook stopped during initialization".into(),
            });
        }
    };
    let app = app.clone();
    let dispatch = std::thread::spawn(move || {
        for (x, y) in receiver {
            if let Err(error) = deliver(&app, x, y) {
                eprintln!("Desktop click handling failed: {error}");
                if let Err(error) = app.emit_to("controls", "desktop-error", &error) {
                    eprintln!("Could not report desktop click error: {error}");
                }
            }
        }
    });
    *monitor = Some(Monitor {
        thread_id,
        hook,
        dispatch,
    });
    Ok(())
}

pub fn stop() -> DesktopResult<()> {
    let mut monitor = MONITOR.lock().map_err(|e| e.to_string())?;
    if let Some(active) = monitor.as_ref() {
        if unsafe { PostThreadMessageW(active.thread_id, WM_QUIT, 0, 0) } == 0 {
            return Err(std::io::Error::last_os_error().to_string());
        }
    }
    if let Some(active) = monitor.take() {
        active
            .hook
            .join()
            .map_err(|_| "Desktop mouse hook panicked")?;
        active
            .dispatch
            .join()
            .map_err(|_| "Desktop click dispatch panicked")?;
    }
    Ok(())
}
