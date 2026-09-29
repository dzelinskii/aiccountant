pub mod banks;
mod http;
mod secrets;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            http::bank_request,
            secrets::secret_session_read,
            secrets::secret_session_write,
            secrets::secret_session_clear,
            secrets::app_token_read,
            secrets::app_token_write,
            secrets::app_token_clear,
        ])
        .run(tauri::generate_context!())
        .expect("приложение не запустилось");
}
