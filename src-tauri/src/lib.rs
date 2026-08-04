pub mod commands;
mod config;
pub mod error;
mod events;
mod folder_watch;
mod gpu;
pub mod image_io;
pub mod inference;
pub mod job;
pub mod download;
pub mod models;
pub mod pipeline;
pub mod processing;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_notification::init())
        .manage(crate::processing::ProcessingState::new())
        .manage(crate::download::DownloadState::new())
        .manage(std::sync::Arc::new(crate::folder_watch::FolderWatchState::new()))
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
