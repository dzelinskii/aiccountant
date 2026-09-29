mod banks;
mod http;
mod secrets;
mod windows;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .on_window_event(windows::on_window_event)
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

#[cfg(test)]
mod security_config {
    use serde_json::Value;

    fn json(text: &str) -> Value {
        serde_json::from_str(text).expect("конфиг разбирается")
    }

    // Страница банка в своём окне — чужой код. Доступ к командам приложения
    // есть только у окна main, а разрешений ядра Tauri фронту не нужно: он
    // зовёт лишь свои команды, и каждое лишнее разрешение открыто и банку,
    // если окно по ошибке окажется в списке
    #[test]
    fn only_main_window_gets_commands_and_no_core_permissions() {
        let capability = json(include_str!("../capabilities/default.json"));
        assert_eq!(capability["windows"], serde_json::json!(["main"]));
        assert!(capability.get("webviews").is_none());
        let permissions = capability["permissions"]
            .as_array()
            .expect("список разрешений");
        for permission in permissions {
            let name = permission.as_str().expect("разрешение строкой");
            assert!(name.starts_with("allow-"), "лишнее разрешение: {name}");
        }
    }

    // Без CSP любой скрипт, попавший в страницу, получил бы IPC приложения
    #[test]
    fn csp_forbids_inline_and_eval() {
        let config = json(include_str!("../tauri.conf.json"));
        let csp = config["app"]["security"]["csp"]
            .as_str()
            .expect("CSP задана строкой");
        let script = csp
            .split(';')
            .map(str::trim)
            .find(|directive| directive.starts_with("script-src"))
            .expect("script-src задан");
        assert_eq!(script, "script-src 'self'");
    }
}
