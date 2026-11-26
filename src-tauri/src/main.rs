#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod desktop;
mod interaction;
mod language;
mod settings;

use settings::{Command, Mode, Settings};
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Mutex, OnceLock,
};
use std::time::{Duration, Instant};
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::TrayIconBuilder,
    Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
};

#[derive(Default)]
struct DesktopState(Mutex<Settings>);

#[derive(Default)]
struct FrameClock {
    requested: AtomicU64,
    stopping: AtomicBool,
    worker: OnceLock<std::thread::Thread>,
}

type DesktopResult<T> = Result<T, String>;

fn settings(app: &tauri::AppHandle) -> DesktopResult<Settings> {
    app.state::<DesktopState>()
        .0
        .lock()
        .map(|state| state.clone())
        .map_err(|error| error.to_string())
}

fn pet(app: &tauri::AppHandle) -> DesktopResult<WebviewWindow> {
    app.get_webview_window("pet")
        .ok_or_else(|| "Pet window is unavailable".to_string())
}

fn authorize(window: &WebviewWindow) -> DesktopResult<()> {
    match window.label() {
        "pet" | "controls" => Ok(()),
        _ => Err("This window cannot control the desktop pet".into()),
    }
}

fn update(app: &tauri::AppHandle, command: Command) -> DesktopResult<Settings> {
    let previous = settings(app)?;
    let mut next = previous.clone();
    next.apply(command)?;
    let window = pet(app)?;
    if previous.visible != next.visible {
        if next.visible {
            window.show().map_err(|e| e.to_string())?;
        } else {
            window.hide().map_err(|e| e.to_string())?;
        }
    }
    *app.state::<DesktopState>()
        .0
        .lock()
        .map_err(|e| e.to_string())? = next.clone();
    app.emit_to("pet", "pet-settings", &next)
        .map_err(|e| e.to_string())?;
    app.emit_to("controls", "pet-settings", &next)
        .map_err(|e| e.to_string())?;
    Ok(next)
}

#[tauri::command]
fn get_settings(window: WebviewWindow, app: tauri::AppHandle) -> DesktopResult<Settings> {
    authorize(&window)?;
    settings(&app)
}

#[tauri::command]
fn update_settings(
    window: WebviewWindow,
    app: tauri::AppHandle,
    command: Command,
) -> DesktopResult<Settings> {
    authorize(&window)?;
    update(&app, command)
}

#[tauri::command]
fn pet_ready(window: WebviewWindow, app: tauri::AppHandle, renderer: String) -> DesktopResult<()> {
    if window.label() != "pet" {
        return Err("Only the pet window can report readiness".into());
    }
    if settings(&app)?.visible {
        window.show().map_err(|e| e.to_string())?;
    }
    eprintln!("Desktop pet ready ({renderer}): {:?}", window.inner_size());
    Ok(())
}

#[tauri::command]
fn cursor_position(window: WebviewWindow, app: tauri::AppHandle) -> DesktopResult<desktop::Point> {
    authorize_pet(&window)?;
    desktop::cursor(cached_layout(&app)?.primary_top)
}

fn authorize_pet(window: &WebviewWindow) -> DesktopResult<()> {
    if window.label() == "pet" {
        Ok(())
    } else {
        Err("Only the pet window can access desktop geometry".into())
    }
}

#[tauri::command]
fn request_animation_frame(
    window: WebviewWindow,
    app: tauri::AppHandle,
    frame_id: u64,
) -> DesktopResult<()> {
    authorize_pet(&window)?;
    let clock = app.state::<FrameClock>();
    clock.requested.store(frame_id, Ordering::Relaxed);
    if let Some(worker) = clock.worker.get() {
        worker.unpark();
    }
    Ok(())
}

fn start_frame_clock(app: tauri::AppHandle) {
    std::thread::spawn(move || {
        let interval = Duration::from_secs_f64(1.0 / 60.0);
        let clock = app.state::<FrameClock>();
        let _ = clock.worker.set(std::thread::current());
        let mut next = Instant::now();
        loop {
            while clock.requested.load(Ordering::Relaxed) == 0
                && !clock.stopping.load(Ordering::Relaxed)
            {
                std::thread::park();
            }
            if clock.stopping.load(Ordering::Relaxed) {
                break;
            }
            std::thread::sleep(next.saturating_duration_since(Instant::now()));
            next = Instant::now() + interval;
            let frame_id = clock.requested.swap(0, Ordering::Relaxed);
            if frame_id != 0 {
                // Requests are coalesced. A slow render cannot build an event backlog.
                if let Err(error) = app.emit_to("pet", "desktop-frame", frame_id) {
                    eprintln!("Desktop animation clock failed: {error}");
                    break;
                }
            }
        }
    });
}

#[tauri::command]
fn desktop_layout(window: WebviewWindow, app: tauri::AppHandle) -> DesktopResult<desktop::Layout> {
    authorize_pet(&window)?;
    let layout = desktop::layout(&window)?;
    app.state::<ScreenState>()
        .0
        .lock()
        .map_err(|e| e.to_string())?
        .layout = Some(layout.clone());
    Ok(layout)
}

#[derive(Default)]
struct ScreenTracking {
    layout: Option<desktop::Layout>,
    previous: Option<usize>,
}

#[derive(Default)]
struct ScreenState(Mutex<ScreenTracking>);

fn cached_layout(app: &tauri::AppHandle) -> DesktopResult<desktop::Layout> {
    app.state::<ScreenState>()
        .0
        .lock()
        .map_err(|e| e.to_string())?
        .layout
        .clone()
        .ok_or_else(|| "Desktop geometry is unavailable".into())
}

#[tauri::command]
fn place_viewport(
    window: WebviewWindow,
    app: tauri::AppHandle,
    bounds: desktop::Rect,
    center: desktop::Point,
) -> DesktopResult<desktop::Rect> {
    authorize_pet(&window)?;
    bounds.validate()?;
    if !center.x.is_finite() || !center.y.is_finite() {
        return Err("Pet coordinates must be finite".into());
    }
    let layout = cached_layout(&app)?;
    let actual = desktop::place(&window, bounds, layout.primary_top)?;
    let screen = layout
        .screens
        .iter()
        .position(|screen| screen.frame.contains(center));
    let state = app.state::<ScreenState>();
    let mut tracking = state.0.lock().map_err(|e| e.to_string())?;
    if screen != tracking.previous {
        if let Some(index) = screen {
            eprintln!(
                "Pet entered display {} ({}) at ({:.1}, {:.1})",
                index + 1,
                layout.screens[index].name,
                center.x,
                center.y
            );
        }
        tracking.previous = screen;
    }
    Ok(actual)
}

fn open_window(app: &tauri::AppHandle, original: bool) -> DesktopResult<()> {
    let language = settings(app)?.language;
    let (label, title, url, width, height) = if original {
        (
            "original",
            language.text("Araneae · Browser Version", "Araneae · 完整原版"),
            "index.html",
            1200.0,
            800.0,
        )
    } else {
        (
            "controls",
            language.text("Araneae · Control Panel", "Araneae · 控制面板"),
            "controls.html",
            408.0,
            560.0,
        )
    };
    let window = match app.get_webview_window(label) {
        Some(window) => window,
        None => WebviewWindowBuilder::new(app, label, WebviewUrl::App(url.into()))
            .title(title)
            .inner_size(width, height)
            .min_inner_size(
                if original { 700.0 } else { 380.0 },
                if original { 560.0 } else { 520.0 },
            )
            .center()
            .build()
            .map_err(|e| e.to_string())?,
    };
    window.show().map_err(|e| e.to_string())?;
    if !original {
        desktop::set_level(&window, None)?;
    }
    window.set_focus().map_err(|e| e.to_string())
}

#[tauri::command]
async fn open_original(window: WebviewWindow, app: tauri::AppHandle) -> DesktopResult<()> {
    authorize(&window)?;
    open_window(&app, true)
}

#[tauri::command]
fn move_to_cursor_screen(window: WebviewWindow, app: tauri::AppHandle) -> DesktopResult<()> {
    authorize(&window)?;
    relocate(&app)
}

fn relocate(app: &tauri::AppHandle) -> DesktopResult<()> {
    let point = desktop::cursor(cached_layout(app)?.primary_top)?;
    update(app, Command::Mode(Mode::Roam))?;
    app.emit_to("pet", "pet-relocate", point)
        .map_err(|e| e.to_string())
}

fn menu_action(app: &tauri::AppHandle, id: &str) -> DesktopResult<()> {
    match id {
        "controls" => open_window(app, false)?,
        "roam" => {
            update(app, Command::Mode(Mode::Roam))?;
        }
        "follow" => {
            update(app, Command::Mode(Mode::Follow))?;
        }
        "observe" => {
            update(app, Command::Mode(Mode::Observe))?;
        }
        "visibility" => {
            update(app, Command::Visible(!settings(app)?.visible))?;
        }
        "quit" => app.exit(0),
        _ => return Err("Unknown menu action".into()),
    }
    Ok(())
}

fn handle_menu(app: &tauri::AppHandle, id: &str) {
    if let Err(error) = menu_action(app, id) {
        eprintln!("Desktop menu action failed: {error}");
        if let Err(open_error) = open_window(app, false) {
            eprintln!("Could not open desktop controls: {open_error}");
        }
        if let Err(emit_error) = app.emit_to("controls", "desktop-error", &error) {
            eprintln!("Could not report desktop error: {emit_error}");
        }
    }
}

fn build_tray(app: &tauri::AppHandle) -> tauri::Result<()> {
    let language = settings(app).map_err(std::io::Error::other)?.language;
    let item = |id, text| MenuItem::with_id(app, id, text, true, None::<&str>);
    let menu = Menu::with_items(
        app,
        &[
            &item("controls", language.text("Control Panel", "控制面板"))?,
            &PredefinedMenuItem::separator(app)?,
            &item("roam", language.text("Patrol", "自主巡逻"))?,
            &item("follow", language.text("Follow Pointer", "跟随鼠标"))?,
            &item("observe", language.text("Observe", "原地观察"))?,
            &PredefinedMenuItem::separator(app)?,
            &item("visibility", language.text("Hide / Show", "隐藏 / 显示"))?,
            &PredefinedMenuItem::separator(app)?,
            &item("quit", language.text("Quit Araneae", "退出 Araneae"))?,
        ],
    )?;
    // macOS recolors the template image to match the menu bar appearance.
    TrayIconBuilder::with_id("spider")
        .icon(tauri::image::Image::new(
            include_bytes!("../icons/tray.rgba"),
            44,
            44,
        ))
        .icon_as_template(true)
        .tooltip(language.text("Araneae · Control Panel", "Araneae · 控制面板"))
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| {
            #[cfg(target_os = "windows")]
            {
                // Creating a WebView2 window must not block the UI event loop.
                let app = app.clone();
                let id = event.id.as_ref().to_owned();
                tauri::async_runtime::spawn_blocking(move || handle_menu(&app, &id));
            }
            #[cfg(not(target_os = "windows"))]
            handle_menu(app, event.id.as_ref());
        })
        .build(app)?;
    Ok(())
}

#[cfg(target_os = "macos")]
fn configure_macos(window: &WebviewWindow) -> tauri::Result<()> {
    use objc2_app_kit::{NSStatusWindowLevel, NSWindow, NSWindowCollectionBehavior};
    let pointer = window.ns_window()?;
    // Tauri setup runs on the main thread and owns this NSWindow for this call.
    let native = unsafe { &*pointer.cast::<NSWindow>() };
    let mut behavior = NSWindowCollectionBehavior::CanJoinAllSpaces
        | NSWindowCollectionBehavior::FullScreenAuxiliary
        | NSWindowCollectionBehavior::Stationary
        | NSWindowCollectionBehavior::IgnoresCycle;
    if objc2::available!(macos = 13.0) {
        // Allow the overlay to join other applications' fullscreen spaces.
        behavior |= NSWindowCollectionBehavior::CanJoinAllApplications;
    }
    native.setCollectionBehavior(behavior);
    native.setLevel(NSStatusWindowLevel);
    Ok(())
}

fn main() {
    tauri::Builder::default()
        .manage(DesktopState::default())
        .manage(ScreenState::default())
        .manage(FrameClock::default())
        .invoke_handler(tauri::generate_handler![
            get_settings,
            update_settings,
            pet_ready,
            cursor_position,
            desktop_layout,
            place_viewport,
            request_animation_frame,
            open_original,
            move_to_cursor_screen,
        ])
        .setup(|app| {
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);
            let window = app
                .get_webview_window("pet")
                .ok_or("Pet window is unavailable")?;
            window.set_title(
                settings(app.handle())?
                    .language
                    .text("Araneae Desktop Companion", "Araneae 桌宠"),
            )?;
            window.set_ignore_cursor_events(true)?;
            #[cfg(target_os = "macos")]
            configure_macos(&window)?;
            let layout = desktop::layout(&window)?;
            eprintln!("Desktop layout: {:?}", layout.screens);
            app.state::<ScreenState>()
                .0
                .lock()
                .map_err(|e| e.to_string())?
                .layout = Some(layout);
            build_tray(app.handle())?;
            interaction::start(app.handle())?;
            start_frame_clock(app.handle().clone());
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "pet" {
                    api.prevent_close();
                    if let Err(error) = update(window.app_handle(), Command::Visible(false)) {
                        eprintln!("Could not hide pet window: {error}");
                    }
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("Failed to initialize Araneae desktop")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                if let Err(error) = interaction::stop() {
                    eprintln!("Could not remove desktop click monitor: {error}");
                }
                let clock = app.state::<FrameClock>();
                clock.stopping.store(true, Ordering::Relaxed);
                if let Some(worker) = clock.worker.get() {
                    worker.unpark();
                }
            }
            if let tauri::RunEvent::ExitRequested {
                code: None, api, ..
            } = event
            {
                // Closing the controls or original page must not terminate the menu bar pet.
                api.prevent_exit();
            }
        });
}
