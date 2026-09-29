mod banks;
mod http;
mod secrets;
mod windows;

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
            windows::bank_window_open,
            windows::bank_window_goto,
            windows::bank_window_url,
            windows::bank_window_cookies,
            windows::bank_window_clear_cookie,
            windows::bank_window_close,
            windows::bank_forget,
        ])
        .run(tauri::generate_context!())
        .expect("приложение не запустилось");
}
