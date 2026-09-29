pub mod banks;
mod http;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![http::bank_request])
        .run(tauri::generate_context!())
        .expect("приложение не запустилось");
}
