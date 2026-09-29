pub mod clipboard_import;
pub mod commands;
mod config;
pub mod download;
pub mod error;
mod events;
mod folder_watch;
mod fs_util;
mod gpu;
mod image_ext;
pub mod image_io;
pub mod inference;
pub mod job;
pub mod models;
pub mod pipeline;
pub mod processing;

pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            crate::clipboard_import::cleanup_session(app.handle());
            Ok(())
        })
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_notification::init())
        .manage(crate::processing::ProcessingState::new())
        .manage(crate::download::DownloadState::new())
        .manage(std::sync::Arc::new(
            crate::folder_watch::FolderWatchState::new(),
        ))
        .invoke_handler(tauri::generate_handler![
            commands::detect_gpu,
            commands::run_benchmark,
            commands::set_ep,
            commands::list_models,
            commands::download_model,
            commands::cancel_download,
            commands::remove_image_background,
            commands::cancel_inference,
            commands::path_exists,
            commands::path_is_dir,
            commands::pick_output_dir,
            commands::clear_output_dir,
            commands::pick_folder,
            commands::list_folder_images,
            commands::ensure_dir,
            commands::watch_folder_start,
            commands::watch_folder_stop,
            commands::get_runtime_info,
            commands::get_config,
            commands::import_clipboard_images,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if matches!(event, tauri::RunEvent::Exit) {
                crate::clipboard_import::cleanup_session(app);
            }
        });
}
