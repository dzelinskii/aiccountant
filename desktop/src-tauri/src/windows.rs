//! Окно входа в банк. У каждого банка свой профиль WebView2 в каталоге данных
//! приложения: там оседают привязка устройства и быстрый вход, и там же живёт
//! флаг закрепления корня Минцифры — окно приложения его не получает, потому
//! что у окружения WebView2 свой каталог.
//!
//! Все команды `async`: создание окна и чтение кук на Windows зависают, если
//! их вызвать на главном потоке. Окна банков — отдельные окна `bank-<код>`, а
//! не дочерние webview окна приложения: права команд выдаются по метке окна, и
//! окно банка не получает ни одной (см. `capabilities/default.json`).

use std::io;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::Serialize;
use tauri::webview::cookie::Cookie;
use tauri::{AppHandle, Manager, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

use crate::banks::{self, Bank};
use crate::secrets;

/// Флаги WebView2, которые Tauri ставит сам: additional_browser_args их
/// заменяет, а не дополняет, поэтому они повторены рядом с закреплением.
const DEFAULT_ARGS: &str = "--disable-features=msWebOoUI,msPdfOOUI,msSmartScreenProtection";

/// Профиль WebView2 и метка окна освобождаются не сразу после закрытия окна, а
/// на ближайших оборотах цикла событий: ждём их повторами (~3 секунды).
const RETRIES: u32 = 10;
const PAUSE: Duration = Duration::from_millis(300);

#[derive(Serialize)]
pub struct CookieOut {
    name: String,
    value: String,
}

fn label(bank: &Bank) -> String {
    format!("bank-{}", bank.code)
}

/// Закрепление ключа корня: «игнорировать ошибки сертификата для цепочек с
/// этим ключом», включая истёкший срок, — та же оговорка, что у прежнего окна
/// входа на Playwright.
fn browser_args() -> String {
    format!(
        "{DEFAULT_ARGS} --ignore-certificate-errors-spki-list={}",
        banks::ROOT_SPKI_SHA256
    )
}

fn profile_dir(app: &AppHandle, bank: &Bank) -> Result<PathBuf, String> {
    let base = app.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(base.join("banks").join(bank.code))
}

/// Адрес из команды окна: разобран и лежит на страницах этого банка. Единственная
/// граница, которая не даёт окну с сохранённым входом уйти на чужой сайт, а
/// чтению кук — отдать их не тому адресу. В текст отказа адрес не попадает:
/// в его query бывают секреты.
fn bank_page(bank: &Bank, raw: &str) -> Result<Url, String> {
    let url = Url::parse(raw).map_err(|_| "Неверный адрес".to_string())?;
    if banks::is_bank_page(bank, &url) {
        Ok(url)
    } else {
        Err(format!(
            "Адрес не относится к страницам банка {}",
            bank.code
        ))
    }
}

/// Куки с точным именем: регистр и подстроки значения не имеют.
fn with_name(cookies: Vec<Cookie<'static>>, name: &str) -> Vec<Cookie<'static>> {
    cookies.into_iter().filter(|c| c.name() == name).collect()
}

/// Повторяет операцию с паузой, пока она не удастся или не кончатся повторы.
/// Пауза блокирует поток: команды идут не на главном потоке, а действие
/// редкое — отдельный таймер асинхронного рантайма ради этого не нужен.
fn retry<E>(
    retries: u32,
    pause: Duration,
    mut operation: impl FnMut() -> Result<(), E>,
) -> Result<(), E> {
    let mut left = retries;
    loop {
        match operation() {
            Err(_) if left > 0 => {
                left -= 1;
                std::thread::sleep(pause);
            }
            result => return result,
        }
    }
}

/// Удалить каталог профиля: WebView2 держит файлы ещё мгновение после
/// закрытия окна, поэтому занятый каталог удаляется повторами. Отсутствие
/// каталога — не ошибка: «забыть» работает и до первого входа.
fn remove_with_retry(
    dir: &Path,
    retries: u32,
    pause: Duration,
    remove: impl Fn(&Path) -> io::Result<()>,
) -> Result<(), String> {
    retry(retries, pause, || match remove(dir) {
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
        other => other,
    })
    .map_err(|e| format!("Профиль банка занят, повторите позже ({e})"))
}

/// Стереть и профиль, и секрет, даже если первое не удалось: иначе забытое
/// наполовину выглядело бы для человека забытым целиком. Ошибка называет всё,
/// что осталось.
fn forget_all(
    remove_profile: impl FnOnce() -> Result<(), String>,
    clear_secret: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    let failures: Vec<String> = [remove_profile(), clear_secret()]
        .into_iter()
        .filter_map(Result::err)
        .collect();
    if failures.is_empty() {
        Ok(())
    } else {
        Err(format!("Доступ забыт не весь: {}", failures.join("; ")))
    }
}

fn window(app: &AppHandle, bank: &Bank) -> Result<WebviewWindow, String> {
    app.get_webview_window(&label(bank))
        .ok_or_else(|| "Окно банка закрыто".to_string())
}

/// Закрыть окно банка, если оно есть, и дождаться, пока Tauri снимет метку:
/// `destroy` лишь отправляет сообщение циклу событий, метка освобождается,
/// когда он его обработает. Без ожидания `bank_window_open` сразу за закрытием
/// отказал бы «окно с такой меткой уже существует».
fn close_and_wait(app: &AppHandle, bank: &Bank) -> Result<(), String> {
    let name = label(bank);
    let Some(win) = app.get_webview_window(&name) else {
        return Ok(());
    };
    win.destroy().map_err(|e| e.to_string())?;
    retry(RETRIES, PAUSE, || match app.get_webview_window(&name) {
        Some(_) => Err(()),
        None => Ok(()),
    })
    .map_err(|()| "Окно банка не закрылось".to_string())
}

/// Открыть окно банка на пустой странице. Пустая, а не страница банка: вход
/// Т-Банка сначала стирает протухшую куку и только потом идёт на страницу входа.
#[tauri::command]
pub async fn bank_window_open(app: AppHandle, bank: String, visible: bool) -> Result<(), String> {
    let bank = banks::bank(&bank)?;
    close_and_wait(&app, bank)?;
    let blank = Url::parse("about:blank").expect("about:blank разбирается");
    WebviewWindowBuilder::new(&app, label(bank), WebviewUrl::External(blank))
        .title("Вход в банк")
        .inner_size(1024.0, 760.0)
        .visible(visible)
        .data_directory(profile_dir(&app, bank)?)
        .additional_browser_args(&browser_args())
        .build()
        .map_err(|e| format!("Окно банка не открылось: {e}"))?;
    Ok(())
}

#[tauri::command]
pub async fn bank_window_goto(app: AppHandle, bank: String, url: String) -> Result<(), String> {
    let bank = banks::bank(&bank)?;
    let url = bank_page(bank, &url)?;
    window(&app, bank)?.navigate(url).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn bank_window_url(app: AppHandle, bank: String) -> Result<String, String> {
    let bank = banks::bank(&bank)?;
    window(&app, bank)?
        .url()
        .map(|u| u.to_string())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn bank_window_cookies(
    app: AppHandle,
    bank: String,
    url: String,
) -> Result<Vec<CookieOut>, String> {
    let bank = banks::bank(&bank)?;
    let url = bank_page(bank, &url)?;
    let cookies = window(&app, bank)?
        .cookies_for_url(url)
        .map_err(|e| e.to_string())?;
    Ok(cookies
        .iter()
        .map(|c| CookieOut {
            name: c.name().to_string(),
            value: c.value().to_string(),
        })
        .collect())
}

#[tauri::command]
pub async fn bank_window_clear_cookie(
    app: AppHandle,
    bank: String,
    name: String,
) -> Result<(), String> {
    let bank = banks::bank(&bank)?;
    let win = window(&app, bank)?;
    let cookies = win.cookies().map_err(|e| e.to_string())?;
    for cookie in with_name(cookies, &name) {
        win.delete_cookie(cookie).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub async fn bank_window_close(app: AppHandle, bank: String) -> Result<(), String> {
    close_and_wait(&app, banks::bank(&bank)?)
}

/// Забыть доступ: профиль окна и секрет сессии.
#[tauri::command]
pub async fn bank_forget(app: AppHandle, bank: String) -> Result<(), String> {
    let bank = banks::bank(&bank)?;
    close_and_wait(&app, bank)?;
    let dir = profile_dir(&app, bank)?;
    forget_all(
        || remove_with_retry(&dir, RETRIES, PAUSE, |d| std::fs::remove_dir_all(d)),
        || secrets::clear_session(&secrets::OsKeyring, bank.code),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    #[test]
    fn window_label_is_per_bank() {
        assert_eq!(label(banks::bank("sber").unwrap()), "bank-sber");
    }

    #[test]
    fn pin_keeps_tauri_defaults() {
        let args = browser_args();
        assert!(args.contains(DEFAULT_ARGS));
        assert!(args.ends_with(&format!(
            "--ignore-certificate-errors-spki-list={}",
            banks::ROOT_SPKI_SHA256
        )));
    }

    #[test]
    fn bank_page_accepts_only_own_pages() {
        let alfa = banks::bank("alfa").unwrap();
        assert!(bank_page(alfa, "https://web.alfabank.ru/").is_ok());
        assert!(bank_page(alfa, "https://private.auth.alfabank.ru/x?a=1").is_ok());
        assert!(
            bank_page(alfa, "https://evil.example/").is_err(),
            "чужой сайт"
        );
        assert!(
            bank_page(alfa, "https://www.tbank.ru/").is_err(),
            "сайт другого банка"
        );
        assert!(
            bank_page(alfa, "http://web.alfabank.ru/").is_err(),
            "не https"
        );
        assert!(bank_page(alfa, "about:blank").is_err(), "не адрес банка");
    }

    #[test]
    fn bank_page_rejects_unparsable_address() {
        let alfa = banks::bank("alfa").unwrap();
        assert_eq!(bank_page(alfa, "не адрес").unwrap_err(), "Неверный адрес");
    }

    #[test]
    fn bank_page_rejection_does_not_leak_query() {
        let tbank = banks::bank("tbank").unwrap();
        let err = bank_page(tbank, "https://evil.example/?sessionid=SECRET").unwrap_err();
        assert!(!err.contains("SECRET"));
    }

    #[test]
    fn cookies_are_picked_by_exact_name() {
        let cookies = vec![
            Cookie::new("sessionid", "1"),
            Cookie::new("sessionid2", "2"),
            Cookie::new("Sessionid", "3"),
            Cookie::new("sessionid", "4"),
        ];
        let picked = with_name(cookies, "sessionid");
        let values: Vec<&str> = picked.iter().map(|c| c.value()).collect();
        assert_eq!(values, ["1", "4"]);
    }

    fn temp_dir(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("aiccountant-windows-{}-{name}", std::process::id()))
    }

    #[test]
    fn missing_profile_is_not_an_error() {
        let dir = temp_dir("missing");
        assert!(remove_with_retry(&dir, 0, Duration::ZERO, |d| std::fs::remove_dir_all(d)).is_ok());
    }

    #[test]
    fn existing_profile_is_removed() {
        let dir = temp_dir("existing");
        std::fs::create_dir_all(dir.join("Default")).unwrap();
        std::fs::write(dir.join("Default").join("Cookies"), b"x").unwrap();
        remove_with_retry(&dir, 0, Duration::ZERO, |d| std::fs::remove_dir_all(d)).unwrap();
        assert!(!dir.exists());
    }

    fn busy() -> io::Error {
        io::Error::new(io::ErrorKind::PermissionDenied, "занято")
    }

    #[test]
    fn busy_profile_is_retried_until_free() {
        let calls = Cell::new(0);
        let result = remove_with_retry(Path::new("p"), 5, Duration::ZERO, |_| {
            calls.set(calls.get() + 1);
            if calls.get() <= 3 {
                Err(busy())
            } else {
                Ok(())
            }
        });
        assert!(result.is_ok());
        assert_eq!(calls.get(), 4);
    }

    #[test]
    fn profile_busy_for_too_long_is_an_error() {
        let calls = Cell::new(0);
        let err = remove_with_retry(Path::new("p"), 3, Duration::ZERO, |_| {
            calls.set(calls.get() + 1);
            Err(busy())
        })
        .unwrap_err();
        assert!(err.starts_with("Профиль банка занят"), "{err}");
        assert_eq!(calls.get(), 4, "первая попытка и три повтора");
    }

    #[test]
    fn missing_profile_is_not_retried() {
        let calls = Cell::new(0);
        remove_with_retry(Path::new("p"), 5, Duration::ZERO, |_| {
            calls.set(calls.get() + 1);
            Err(io::ErrorKind::NotFound.into())
        })
        .unwrap();
        assert_eq!(calls.get(), 1);
    }

    #[test]
    fn forget_clears_both_when_all_goes_well() {
        assert!(forget_all(|| Ok(()), || Ok(())).is_ok());
    }

    #[test]
    fn failed_profile_does_not_keep_the_secret() {
        let cleared = Cell::new(false);
        let err = forget_all(
            || Err("Профиль банка занят".into()),
            || {
                cleared.set(true);
                Ok(())
            },
        )
        .unwrap_err();
        assert!(cleared.get(), "секрет стёрт, хоть профиль и не удалился");
        assert!(err.contains("Профиль банка занят"), "{err}");
        assert!(!err.contains("Хранилище"), "{err}");
    }

    #[test]
    fn failed_secret_does_not_keep_the_profile() {
        let removed = Cell::new(false);
        let err = forget_all(
            || {
                removed.set(true);
                Ok(())
            },
            || Err("Хранилище секретов недоступно".into()),
        )
        .unwrap_err();
        assert!(removed.get(), "профиль удалён, хоть секрет и не стёрся");
        assert!(err.contains("Хранилище секретов недоступно"), "{err}");
        assert!(!err.contains("Профиль"), "{err}");
    }

    #[test]
    fn both_failures_are_reported() {
        let err = forget_all(
            || Err("Профиль банка занят".into()),
            || Err("Хранилище секретов недоступно".into()),
        )
        .unwrap_err();
        assert!(err.contains("Профиль банка занят"), "{err}");
        assert!(err.contains("Хранилище секретов недоступно"), "{err}");
    }

    #[test]
    fn retry_stops_at_first_success() {
        let calls = Cell::new(0);
        let result: Result<(), ()> = retry(9, Duration::ZERO, || {
            calls.set(calls.get() + 1);
            if calls.get() < 2 {
                Err(())
            } else {
                Ok(())
            }
        });
        assert!(result.is_ok());
        assert_eq!(calls.get(), 2);
    }
}
