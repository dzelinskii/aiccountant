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
use std::sync::mpsc;
use std::time::Duration;

use serde::Serialize;
use tauri::webview::cookie::Cookie;
use tauri::{
    AppHandle, Manager, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder, Window, WindowEvent,
};

use crate::banks::{self, Bank};
use crate::secrets;

/// Метка окна приложения (`tauri.conf.json`): его закрытие уводит за собой
/// окна банков.
const MAIN_LABEL: &str = "main";
const BANK_LABEL_PREFIX: &str = "bank-";

/// Флаги WebView2, которые wry ставит сам (`default_args` в
/// `wry-0.57.0/src/webview2/mod.rs`): additional_browser_args их заменяет, а не
/// дополняет, поэтому они повторены рядом с закреплением. Имена фич Chromium
/// регистрозависимы, писать их надо ровно как в wry.
const DEFAULT_ARGS: &str = "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection";

/// Профиль WebView2 освобождается не сразу после закрытия окна: удаление
/// профиля повторяется (~3 секунды).
const RETRIES: u32 = 10;
const PAUSE: Duration = Duration::from_millis(300);

/// Сколько ждать, пока окно закроется и Tauri снимет его метку.
const CLOSE_TIMEOUT: Duration = Duration::from_secs(3);

/// WebView2 применяет удаление куки с задержкой (на замере — около 30 мс), а не
/// сразу: пока не прошла, кука ещё видна в `cookies()`.
const COOKIE_RETRIES: u32 = 20;
const COOKIE_PAUSE: Duration = Duration::from_millis(50);

#[derive(Serialize)]
pub struct CookieOut {
    name: String,
    value: String,
}

fn label(bank: &Bank) -> String {
    format!("{BANK_LABEL_PREFIX}{}", bank.code)
}

fn is_bank_label(label: &str) -> bool {
    label.starts_with(BANK_LABEL_PREFIX)
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

/// Профиль лежит в локальном каталоге данных, а не в перемещаемом: привязка
/// устройства и кэш WebView2 не должны уезжать на другой компьютер вместе с
/// перемещаемым профилем Windows.
fn profile_under(base: &Path, bank: &Bank) -> PathBuf {
    base.join("banks").join(bank.code)
}

fn profile_dir(app: &AppHandle, bank: &Bank) -> Result<PathBuf, String> {
    let base = app.path().app_local_data_dir().map_err(|e| e.to_string())?;
    Ok(profile_under(&base, bank))
}

/// Адрес из команды окна: разобран и лежит на страницах этого банка. Не даёт
/// нашей команде отправить окно с сохранённым входом на чужой сайт, а чтению
/// кук — отдать их не тому адресу; сама страница банка может вести куда угодно.
/// В текст отказа адрес не попадает: в его query бывают секреты.
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

/// Чем удалять куку. WebView2 удаляет по точному (имя, домен, путь), а домен
/// доменной куки хранит с ведущей точкой (`.tbank.ru`); `Cookie::domain()`
/// точку срезает, и обычное удаление её не находит (замер на прототипе:
/// доменная кука остаётся). Вариант с точкой получается двумя точками в
/// `set_domain`: `domain()` срежет одну, и в WebView2 уйдёт `.tbank.ru`. Для
/// куки хоста такой вариант ничего не находит и безвреден.
fn delete_variants(cookie: &Cookie<'static>) -> Vec<Cookie<'static>> {
    let mut variants = vec![cookie.clone()];
    if let Some(domain) = cookie.domain() {
        let mut dotted = cookie.clone();
        dotted.set_domain(format!("..{domain}"));
        variants.push(dotted);
    }
    variants
}

/// Стереть куки с этим именем и дождаться, пока они исчезнут: не исчезли —
/// ошибка, а не молчаливый успех.
fn clear_named(
    name: &str,
    mut read: impl FnMut() -> Result<Vec<Cookie<'static>>, String>,
    mut delete: impl FnMut(&Cookie<'static>) -> Result<(), String>,
    retries: u32,
    pause: Duration,
) -> Result<(), String> {
    for cookie in with_name(read()?, name) {
        for variant in delete_variants(&cookie) {
            delete(&variant)?;
        }
    }
    retry(retries, pause, || {
        if with_name(read()?, name).is_empty() {
            Ok(())
        } else {
            Err(format!("Кука {name} не удалилась"))
        }
    })
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

/// Забыть доступ: профиль и секрет сессии. Стирается и то и другое, даже если
/// первое не удалось: иначе забытое наполовину выглядело бы забытым целиком.
/// Секрет стирается всегда, а профиль — только если окно закрылось (пока оно
/// открыто, профиль занят). Ошибка называет всё, что осталось.
fn forget(
    remove_profile: impl FnOnce() -> Result<(), String>,
    backend: &impl secrets::Backend,
    bank: &Bank,
    closed: Result<(), String>,
) -> Result<(), String> {
    let profile = match closed {
        Ok(()) => remove_profile(),
        Err(e) => Err(format!("Профиль не удалён: {e}")),
    };
    let secret = secrets::clear_session(backend, bank.code);
    let failures: Vec<String> = [profile, secret]
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

/// Закрыть окно банка, если оно есть, и дождаться его закрытия: `destroy` лишь
/// отправляет сообщение циклу событий, а метку Tauri снимает, когда тот его
/// обработает — раньше, чем вызовет обработчики окна. Без ожидания
/// `bank_window_open` сразу за закрытием отказал бы «окно с такой меткой уже
/// существует». Подписка — до `destroy`, иначе событие можно пропустить.
fn close_and_wait(app: &AppHandle, bank: &Bank) -> Result<(), String> {
    let Some(win) = app.get_webview_window(&label(bank)) else {
        return Ok(());
    };
    let (tx, rx) = mpsc::channel();
    win.on_window_event(move |event| {
        if matches!(event, WindowEvent::Destroyed) {
            let _ = tx.send(());
        }
    });
    win.destroy().map_err(|e| e.to_string())?;
    rx.recv_timeout(CLOSE_TIMEOUT)
        .map_err(|_| "Окно банка не закрылось".to_string())
}

/// Закрытие окна приложения уводит за собой окна банков: скрытое окно
/// (фоновое обновление Т-Банка) само процесс не завершает, но и не даёт ему
/// завершиться.
fn closes_banks(label: &str, event: &WindowEvent) -> bool {
    label == MAIN_LABEL && matches!(event, WindowEvent::Destroyed)
}

pub fn on_window_event(window: &Window, event: &WindowEvent) {
    if !closes_banks(window.label(), event) {
        return;
    }
    for (name, win) in window.app_handle().webview_windows() {
        if is_bank_label(&name) {
            if let Err(e) = win.destroy() {
                eprintln!("Окно {name} не закрылось при выходе: {e}");
            }
        }
    }
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
    clear_named(
        &name,
        || win.cookies().map_err(|e| e.to_string()),
        |cookie| win.delete_cookie(cookie.clone()).map_err(|e| e.to_string()),
        COOKIE_RETRIES,
        COOKIE_PAUSE,
    )
}

#[tauri::command]
pub async fn bank_window_close(app: AppHandle, bank: String) -> Result<(), String> {
    close_and_wait(&app, banks::bank(&bank)?)
}

#[tauri::command]
pub async fn bank_forget(app: AppHandle, bank: String) -> Result<(), String> {
    let bank = banks::bank(&bank)?;
    let closed = close_and_wait(&app, bank);
    forget(
        || {
            let dir = profile_dir(&app, bank)?;
            remove_with_retry(&dir, RETRIES, PAUSE, |d| std::fs::remove_dir_all(d))
        },
        &secrets::OsKeyring,
        bank,
        closed,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::secrets::tests::Memory;
    use std::cell::{Cell, RefCell};

    #[test]
    fn window_label_is_per_bank() {
        assert_eq!(label(banks::bank("sber").unwrap()), "bank-sber");
    }

    #[test]
    fn every_bank_window_is_recognised_and_main_is_not() {
        for b in banks::BANKS {
            assert!(is_bank_label(&label(b)), "{}", b.code);
        }
        assert!(!is_bank_label(MAIN_LABEL));
    }

    #[test]
    fn only_destroying_main_closes_banks() {
        assert!(closes_banks("main", &WindowEvent::Destroyed));
        assert!(!closes_banks("main", &WindowEvent::Focused(true)));
        assert!(!closes_banks("bank-sber", &WindowEvent::Destroyed));
    }

    #[test]
    fn pin_keeps_wry_defaults() {
        // Литерал из wry-0.57.0/src/webview2/mod.rs (default_args), нарочно не
        // через константу: опечатка в регистре отключит не ту фичу Chromium.
        let wry = "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection";
        let args = browser_args();
        assert!(args.starts_with(wry), "{args}");
        assert!(args.ends_with(&format!(
            "--ignore-certificate-errors-spki-list={}",
            banks::ROOT_SPKI_SHA256
        )));
    }

    #[test]
    fn profile_is_per_bank_under_base() {
        let base = Path::new("base");
        let tbank = profile_under(base, banks::bank("tbank").unwrap());
        let sber = profile_under(base, banks::bank("sber").unwrap());
        assert_eq!(tbank, base.join("banks").join("tbank"));
        assert_ne!(tbank, sber);
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

    fn domain_cookie(name: &str, domain: &str) -> Cookie<'static> {
        Cookie::build((name.to_string(), "v"))
            .domain(domain.to_string())
            .path("/")
            .build()
    }

    #[test]
    fn domain_cookie_gets_a_dotted_delete_variant() {
        let variants = delete_variants(&domain_cookie("psid", "tbank.ru"));
        let domains: Vec<Option<&str>> = variants.iter().map(|c| c.domain()).collect();
        assert_eq!(domains, [Some("tbank.ru"), Some(".tbank.ru")]);
        assert!(variants.iter().all(|c| c.path() == Some("/")));
    }

    #[test]
    fn cookie_without_domain_has_one_delete_variant() {
        assert_eq!(delete_variants(&Cookie::new("sid", "v")).len(), 1);
    }

    /// Хранилище кук как у WebView2: удаляет по точному домену (в том виде,
    /// как `wry` его передаёт), а исчезновение видно только через `lag` чтений.
    struct Jar {
        /// (имя, домен как хранит WebView2: у доменной куки с точкой)
        items: RefCell<Vec<(String, String)>>,
        doomed: RefCell<Vec<(String, String)>>,
        lag: Cell<u32>,
    }

    impl Jar {
        fn new(items: &[(&str, &str)], lag: u32) -> Self {
            let items = items
                .iter()
                .map(|(n, d)| (n.to_string(), d.to_string()))
                .collect();
            Jar {
                items: RefCell::new(items),
                doomed: RefCell::new(Vec::new()),
                lag: Cell::new(lag),
            }
        }

        fn read(&self) -> Result<Vec<Cookie<'static>>, String> {
            if !self.doomed.borrow().is_empty() {
                if self.lag.get() == 0 {
                    let doomed = self.doomed.take();
                    self.items.borrow_mut().retain(|i| !doomed.contains(i));
                } else {
                    self.lag.set(self.lag.get() - 1);
                }
            }
            // cookie::Cookie::domain() срезает одну ведущую точку — как при
            // чтении из WebView2
            Ok(self
                .items
                .borrow()
                .iter()
                .map(|(n, d)| domain_cookie(n, d))
                .collect())
        }

        fn delete(&self, cookie: &Cookie<'static>) -> Result<(), String> {
            let key = (
                cookie.name().to_string(),
                cookie.domain().unwrap().to_string(),
            );
            if self.items.borrow().contains(&key) {
                self.doomed.borrow_mut().push(key);
            }
            Ok(())
        }

        fn names(&self) -> Vec<String> {
            self.items.borrow().iter().map(|(n, _)| n.clone()).collect()
        }
    }

    fn clear(jar: &Jar, name: &str, retries: u32) -> Result<(), String> {
        clear_named(
            name,
            || jar.read(),
            |c| jar.delete(c),
            retries,
            Duration::ZERO,
        )
    }

    #[test]
    fn host_cookie_is_cleared_and_others_stay() {
        let jar = Jar::new(&[("psid", "a.tbank.ru"), ("keep", "a.tbank.ru")], 0);
        clear(&jar, "psid", 3).unwrap();
        assert_eq!(jar.names(), ["keep"]);
    }

    #[test]
    fn domain_cookie_is_cleared_through_the_dotted_variant() {
        // в WebView2 доменная кука хранится с ведущей точкой: обычным
        // удалением она не берётся
        let jar = Jar::new(&[("psid", ".tbank.ru")], 0);
        clear(&jar, "psid", 3).unwrap();
        assert!(jar.names().is_empty());
    }

    #[test]
    fn slow_deletion_is_waited_for() {
        let jar = Jar::new(&[("psid", "a.tbank.ru")], 2);
        clear(&jar, "psid", 5).unwrap();
        assert!(jar.names().is_empty());
    }

    #[test]
    fn cookie_that_stays_is_an_error() {
        let jar = Jar::new(&[("psid", "a.tbank.ru")], 0);
        let err = clear_named("psid", || jar.read(), |_| Ok(()), 2, Duration::ZERO).unwrap_err();
        assert_eq!(err, "Кука psid не удалилась");
    }

    #[test]
    fn missing_cookie_is_not_an_error() {
        let jar = Jar::new(&[("keep", "a.tbank.ru")], 0);
        clear(&jar, "psid", 0).unwrap();
        assert_eq!(jar.names(), ["keep"]);
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

    fn tbank() -> &'static Bank {
        banks::bank("tbank").unwrap()
    }

    fn memory_with_sessions() -> Memory {
        let m = Memory::default();
        secrets::write_session(&m, "tbank", "secret").unwrap();
        secrets::write_session(&m, "sber", "other").unwrap();
        m
    }

    #[test]
    fn forget_removes_profile_and_only_this_banks_secret() {
        let m = memory_with_sessions();
        let removed = Cell::new(false);
        forget(
            || {
                removed.set(true);
                Ok(())
            },
            &m,
            tbank(),
            Ok(()),
        )
        .unwrap();
        assert!(removed.get());
        assert_eq!(secrets::read_session(&m, "tbank").unwrap(), None);
        assert_eq!(
            secrets::read_session(&m, "sber").unwrap().as_deref(),
            Some("other")
        );
    }

    #[test]
    fn failed_profile_does_not_keep_the_secret() {
        let m = memory_with_sessions();
        let err = forget(|| Err("Профиль банка занят".into()), &m, tbank(), Ok(())).unwrap_err();
        assert_eq!(secrets::read_session(&m, "tbank").unwrap(), None);
        assert!(err.contains("Профиль банка занят"), "{err}");
    }

    #[test]
    fn unclosed_window_still_clears_the_secret_and_leaves_the_profile() {
        let m = memory_with_sessions();
        let touched = Cell::new(false);
        let err = forget(
            || {
                touched.set(true);
                Ok(())
            },
            &m,
            tbank(),
            Err("Окно банка не закрылось".into()),
        )
        .unwrap_err();
        assert!(!touched.get(), "пока окно открыто, профиль не трогаем");
        assert_eq!(secrets::read_session(&m, "tbank").unwrap(), None);
        assert!(err.contains("Окно банка не закрылось"), "{err}");
    }

    struct BrokenKeyring;

    impl secrets::Backend for BrokenKeyring {
        fn get(&self, _: &str) -> Result<Option<String>, String> {
            Ok(None)
        }
        fn set(&self, _: &str, _: &str) -> Result<(), String> {
            Ok(())
        }
        fn delete(&self, _: &str) -> Result<(), String> {
            Err("Хранилище секретов недоступно".into())
        }
    }

    #[test]
    fn failed_secret_does_not_keep_the_profile_and_is_reported() {
        let removed = Cell::new(false);
        let err = forget(
            || {
                removed.set(true);
                Ok(())
            },
            &BrokenKeyring,
            tbank(),
            Ok(()),
        )
        .unwrap_err();
        assert!(removed.get(), "профиль удалён, хоть секрет и не стёрся");
        assert!(err.contains("Хранилище секретов недоступно"), "{err}");
        assert!(!err.contains("Профиль"), "{err}");
    }

    #[test]
    fn both_failures_are_reported() {
        let err = forget(
            || Err("Профиль банка занят".into()),
            &BrokenKeyring,
            tbank(),
            Ok(()),
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
