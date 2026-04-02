// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::{Manager, CustomMenuItem, SystemTray, SystemTrayMenu, SystemTrayMenuItem};
use std::env;

/**
 * Datran Sovereign - Core Rust Module
 * 
 * Implements OS-level integrations like Context Menus and Clipboard hooks.
 */

// Command to generate a link from the native side (simulated bridge)
#[tauri::command]
fn generate_datran_link(file_path: String) -> String {
    println!("[Native] Generating Datran link for: {}", file_path);
    // In production, this would call the Datran engine via a background worker or API
    format!("https://diocom.io/v1/{}?godtier=true", uuid::Uuid::new_v4())
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
                            let window = app.get_window("main").unwrap();
                            window.show().unwrap();
                            window.set_focus().unwrap();
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
