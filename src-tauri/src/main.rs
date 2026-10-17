// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::{Manager, CustomMenuItem, SystemTray, SystemTrayMenu, SystemTrayMenuItem};
use std::env;

/**
 * Datran desktop shell.
 *
 * Wraps the diocom-app web portal and adds a system tray.
 */

// Native link generation is not implemented yet; uploads go through the web portal.
#[tauri::command]
fn generate_datran_link(file_path: String) -> Result<String, String> {
    Err(format!(
        "Native link generation is not implemented; upload '{}' through the portal",
        file_path
    ))
}

fn main() {
    // Check if we were launched with a file path (Context Menu trigger)
    let args: Vec<String> = env::args().collect();
    let initial_file = if args.len() > 1 {
        Some(args[1].clone())
    } else {
        None
    };

    // System Tray Setup
    const QUIT: &str = "quit";
    const OPEN: &str = "open";
    
    let quit = CustomMenuItem::new(QUIT.to_string(), "Quit Datran");
    let open = CustomMenuItem::new(OPEN.to_string(), "Open Portal");
    let tray_menu = SystemTrayMenu::new()
        .add_item(open)
        .add_native_item(SystemTrayMenuItem::Separator)
        .add_item(quit);

    let system_tray = SystemTray::new().with_menu(tray_menu);

    tauri::Builder::default()
        .system_tray(system_tray)
        .on_system_tray_event(|app, event| {
            match event {
                tauri::SystemTrayEvent::MenuItemClick { id, .. } => {
                    match id.as_str() {
                        QUIT => {
                            std::process::exit(0);
                        }
                        OPEN => {
                            if let Some(window) = app.get_window("main") {
                                let _ = window.show();
                                let _ = window.set_focus();
                            }
                        }
                        _ => {}
                    }
                }
                _ => {}
            }
        })
        .setup(move |app| {
            if let Some(path) = initial_file {
                println!("[Native] Launched with file: {}", path);
                // We would emit an event to the frontend to start the upload automatically
                let _ = app.emit_all("file-received", path);
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![generate_datran_link])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
