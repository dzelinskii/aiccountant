// Команда, которой нет в этом списке, из окна не вызывается вовсе.
fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "bank_request",
            "secret_session_read",
            "secret_session_write",
            "secret_session_clear",
            "app_token_read",
            "app_token_write",
            "app_token_clear",
            "bank_window_open",
            "bank_window_goto",
            "bank_window_url",
            "bank_window_cookies",
            "bank_window_clear_cookie",
            "bank_window_close",
            "bank_forget",
        ]),
    ))
    .expect("сборка манифеста команд");
}
