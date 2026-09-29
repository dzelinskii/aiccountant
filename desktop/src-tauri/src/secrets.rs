//! Секреты устройства в хранилище ОС: Credential Manager, Keychain.
//!
//! Записи разделены по видам, и у каждого вида свои команды. Общей команды
//! «прочитать секрет по имени» нет намеренно: следующий вид — ПИН-код банка —
//! окну приложения читать нельзя вовсе, и он не должен получить готовую дверь.
//! Все чтения и записи идут через этот модуль — сюда же встанет шифрование
//! мастер-кодом, если его заведут.

use crate::banks;

const SERVICE: &str = "aiccountant";
const APP_TOKEN_KEY: &str = "app-token";
const TOO_LONG: &str = "Секрет длиннее, чем принимает хранилище ОС";

pub trait Backend {
    fn get(&self, key: &str) -> Result<Option<String>, String>;
    fn set(&self, key: &str, value: &str) -> Result<(), String>;
    fn delete(&self, key: &str) -> Result<(), String>;
}

pub struct OsKeyring;

impl Backend for OsKeyring {
    fn get(&self, key: &str) -> Result<Option<String>, String> {
        get_entry(&entry(key)?)
    }

    fn set(&self, key: &str, value: &str) -> Result<(), String> {
        set_entry(&entry(key)?, value)
    }

    fn delete(&self, key: &str) -> Result<(), String> {
        delete_entry(&entry(key)?)
    }
}

// Ветвление по ошибкам вынесено из `OsKeyring`, чтобы гонять его на
// поддельной записи без ОС: живое хранилище ошибку по заказу не отдаёт.
fn get_entry(entry: &keyring::Entry) -> Result<Option<String>, String> {
    match entry.get_password() {
        Ok(value) => Ok(Some(value)),
        // Запись, которую не разобрать, — не сбой, а «секрета нет»: человек
        // просто войдёт заново, а не будет чистить хранилище руками (так же
        // читается негодная запись в `collector/src/collect/credentials-codec.ts`).
        Err(keyring::Error::NoEntry | keyring::Error::BadEncoding(_)) => Ok(None),
        Err(e) => Err(unavailable(e)),
    }
}

fn set_entry(entry: &keyring::Entry, value: &str) -> Result<(), String> {
    entry.set_password(value).map_err(|e| match e {
        // слишком длинное значение — не сбой хранилища: чинится не повтором, а
        // другим размером, и сообщение должно это сказать
        keyring::Error::TooLong(..) => TOO_LONG.to_string(),
        other => unavailable(other),
    })
}

// стирать нечего — не ошибка: «забыть доступ» работает и до первого входа
fn delete_entry(entry: &keyring::Entry) -> Result<(), String> {
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(unavailable(e)),
    }
}

fn entry(key: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE, key).map_err(unavailable)
}

// сбой хранилища — не «секрета нет»: иначе «доступ забыт» звучало бы, когда он
// не забыт, а чтение отправляло бы на вход вместо честного сообщения
fn unavailable(error: keyring::Error) -> String {
    format!("Хранилище секретов недоступно ({error})")
}

fn session_key(bank: &str) -> Result<String, String> {
    Ok(format!("session:{}", banks::bank(bank)?.code))
}

pub fn read_session(backend: &impl Backend, bank: &str) -> Result<Option<String>, String> {
    backend.get(&session_key(bank)?)
}

pub fn write_session(backend: &impl Backend, bank: &str, value: &str) -> Result<(), String> {
    backend.set(&session_key(bank)?, value)
}

pub fn clear_session(backend: &impl Backend, bank: &str) -> Result<(), String> {
    backend.delete(&session_key(bank)?)
}

pub fn read_app_token(backend: &impl Backend) -> Result<Option<String>, String> {
    backend.get(APP_TOKEN_KEY)
}

pub fn write_app_token(backend: &impl Backend, token: &str) -> Result<(), String> {
    backend.set(APP_TOKEN_KEY, token)
}

pub fn clear_app_token(backend: &impl Backend) -> Result<(), String> {
    backend.delete(APP_TOKEN_KEY)
}

#[tauri::command]
pub fn secret_session_read(bank: String) -> Result<Option<String>, String> {
    read_session(&OsKeyring, &bank)
}

#[tauri::command]
pub fn secret_session_write(bank: String, value: String) -> Result<(), String> {
    write_session(&OsKeyring, &bank, &value)
}

#[tauri::command]
pub fn secret_session_clear(bank: String) -> Result<(), String> {
    clear_session(&OsKeyring, &bank)
}

#[tauri::command]
pub fn app_token_read() -> Result<Option<String>, String> {
    read_app_token(&OsKeyring)
}

#[tauri::command]
pub fn app_token_write(token: String) -> Result<(), String> {
    write_app_token(&OsKeyring, &token)
}

#[tauri::command]
pub fn app_token_clear() -> Result<(), String> {
    clear_app_token(&OsKeyring)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::collections::HashMap;

    #[derive(Default)]
    struct Memory(RefCell<HashMap<String, String>>);

    impl Backend for Memory {
        fn get(&self, key: &str) -> Result<Option<String>, String> {
            Ok(self.0.borrow().get(key).cloned())
        }
        fn set(&self, key: &str, value: &str) -> Result<(), String> {
            self.0.borrow_mut().insert(key.into(), value.into());
            Ok(())
        }
        fn delete(&self, key: &str) -> Result<(), String> {
            self.0.borrow_mut().remove(key);
            Ok(())
        }
    }

    #[test]
    fn sessions_of_banks_do_not_mix() {
        let m = Memory::default();
        write_session(&m, "sber", "s").unwrap();
        write_session(&m, "alfa", "a").unwrap();
        assert_eq!(read_session(&m, "sber").unwrap().as_deref(), Some("s"));
        assert_eq!(read_session(&m, "alfa").unwrap().as_deref(), Some("a"));
    }

    #[test]
    fn app_token_is_not_a_bank_session() {
        let m = Memory::default();
        write_app_token(&m, "token").unwrap();
        for bank in ["tbank", "sber", "alfa"] {
            assert_eq!(read_session(&m, bank).unwrap(), None);
        }
    }

    #[test]
    fn bank_session_is_not_app_token() {
        let m = Memory::default();
        for bank in ["tbank", "sber", "alfa"] {
            write_session(&m, bank, "session").unwrap();
        }
        assert_eq!(read_app_token(&m).unwrap(), None);
    }

    #[test]
    fn app_token_roundtrip_and_clear() {
        let m = Memory::default();
        write_app_token(&m, "token").unwrap();
        assert_eq!(read_app_token(&m).unwrap().as_deref(), Some("token"));
        clear_app_token(&m).unwrap();
        assert_eq!(read_app_token(&m).unwrap(), None);
        clear_app_token(&m).unwrap();
    }

    #[test]
    fn clearing_session_keeps_app_token() {
        let m = Memory::default();
        write_app_token(&m, "token").unwrap();
        write_session(&m, "tbank", "t").unwrap();
        clear_session(&m, "tbank").unwrap();
        assert_eq!(read_app_token(&m).unwrap().as_deref(), Some("token"));
    }

    #[test]
    fn unknown_bank_is_not_a_key() {
        let m = Memory::default();
        assert!(read_session(&m, "app-token").is_err());
        assert!(write_session(&m, "../app-token", "x").is_err());
        assert!(clear_session(&m, "app-token").is_err());
    }

    #[test]
    fn clear_is_idempotent() {
        let m = Memory::default();
        clear_session(&m, "tbank").unwrap();
        write_session(&m, "tbank", "t").unwrap();
        clear_session(&m, "tbank").unwrap();
        assert_eq!(read_session(&m, "tbank").unwrap(), None);
    }

    fn mock_entry() -> keyring::Entry {
        keyring::Entry::new_with_credential(Box::new(keyring::mock::MockCredential::default()))
    }

    fn fail_next(entry: &keyring::Entry, error: keyring::Error) {
        let mock: &keyring::mock::MockCredential = entry.get_credential().downcast_ref().unwrap();
        mock.set_error(error);
    }

    fn platform_failure() -> keyring::Error {
        keyring::Error::PlatformFailure("сбой".into())
    }

    #[test]
    fn entry_roundtrip_and_absence() {
        let e = mock_entry();
        assert_eq!(get_entry(&e).unwrap(), None);
        set_entry(&e, "v").unwrap();
        assert_eq!(get_entry(&e).unwrap().as_deref(), Some("v"));
        delete_entry(&e).unwrap();
        assert_eq!(get_entry(&e).unwrap(), None);
        delete_entry(&e).unwrap();
    }

    #[test]
    fn storage_failure_on_get_is_an_error_not_absence() {
        let e = mock_entry();
        fail_next(&e, platform_failure());
        assert!(get_entry(&e).is_err());
    }

    #[test]
    fn unreadable_record_reads_as_absence() {
        let e = mock_entry();
        fail_next(&e, keyring::Error::BadEncoding(vec![0xff]));
        assert_eq!(get_entry(&e).unwrap(), None);
    }

    #[test]
    fn storage_failure_on_delete_is_an_error_not_forgotten() {
        let e = mock_entry();
        set_entry(&e, "v").unwrap();
        fail_next(&e, platform_failure());
        assert!(delete_entry(&e).is_err());
    }

    #[test]
    fn too_long_value_is_reported_as_too_long_not_unavailable() {
        let e = mock_entry();
        fail_next(&e, keyring::Error::TooLong("secret".into(), 2560));
        assert_eq!(set_entry(&e, "v").unwrap_err(), TOO_LONG);
    }

    // `BadEncoding` несёт байты самой записи, и `{error:?}` вывел бы их как список
    // чисел, а не текстом, — поэтому ищем значение в обоих видах.
    #[test]
    fn error_text_does_not_carry_the_value() {
        let value = b"S3CR3T-VALUE".to_vec();
        let as_bytes = format!("{value:?}");
        let leaks = |message: &str| {
            message.contains("S3CR3T-VALUE") || message.contains(as_bytes.trim_matches(['[', ']']))
        };
        let bad_encoding = || keyring::Error::BadEncoding(value.clone());

        let e = mock_entry();
        fail_next(&e, bad_encoding());
        assert!(!leaks(&set_entry(&e, "v").unwrap_err()));
        set_entry(&e, "v").unwrap();
        fail_next(&e, bad_encoding());
        assert!(!leaks(&delete_entry(&e).unwrap_err()));
        fail_next(&e, bad_encoding());
        if let Err(message) = get_entry(&e) {
            assert!(!leaks(&message));
        }
        assert!(!leaks(&unavailable(bad_encoding())));
    }

    #[test]
    fn storage_failure_on_set_is_an_error() {
        let e = mock_entry();
        fail_next(&e, platform_failure());
        assert!(set_entry(&e, "v").is_err());
    }

    // Живое хранилище ОС: `cargo test -- --ignored`. Обычный прогон его не
    // трогает, чтобы не писать в Credential Manager разработчика и CI.
    mod live {
        use super::*;

        // пробная запись стирается при выходе, в том числе при провале теста
        struct Probe(String);

        impl Probe {
            fn new(tag: &str) -> Self {
                let key = format!("test-probe-{tag}-{}", std::process::id());
                OsKeyring.delete(&key).unwrap();
                Probe(key)
            }
        }

        impl Drop for Probe {
            fn drop(&mut self) {
                let _ = OsKeyring.delete(&self.0);
            }
        }

        #[test]
        #[ignore = "пишет в хранилище ОС"]
        fn roundtrip_write_read_clear() {
            let p = Probe::new("roundtrip");
            assert_eq!(OsKeyring.get(&p.0).unwrap(), None);
            OsKeyring.set(&p.0, "value").unwrap();
            assert_eq!(OsKeyring.get(&p.0).unwrap().as_deref(), Some("value"));
            OsKeyring.delete(&p.0).unwrap();
            assert_eq!(OsKeyring.get(&p.0).unwrap(), None);
            // повторное стирание — не ошибка
            OsKeyring.delete(&p.0).unwrap();
        }

        #[test]
        #[ignore = "пишет в хранилище ОС"]
        fn cyrillic_and_specials_survive() {
            let p = Probe::new("unicode");
            let value = "Привет; a=b \"q\" 'x' \\ ёЁ 🙂";
            OsKeyring.set(&p.0, value).unwrap();
            assert_eq!(OsKeyring.get(&p.0).unwrap().as_deref(), Some(value));
        }

        #[test]
        #[ignore = "пишет в хранилище ОС"]
        fn overwrite_replaces_value() {
            let p = Probe::new("overwrite");
            OsKeyring.set(&p.0, "one").unwrap();
            OsKeyring.set(&p.0, "two").unwrap();
            assert_eq!(OsKeyring.get(&p.0).unwrap().as_deref(), Some("two"));
        }

        // Запись, которую не разобрать как текст (здесь — одинокий суррогат
        // UTF-16), читается как «секрета нет».
        #[test]
        #[ignore = "пишет в хранилище ОС"]
        fn unreadable_value_reads_as_absence() {
            let p = Probe::new("unreadable");
            entry(&p.0).unwrap().set_secret(&[0x00, 0xd8]).unwrap();
            assert_eq!(OsKeyring.get(&p.0).unwrap(), None);
        }

        // Печатает предел длины ASCII-записи; запуск с `--nocapture`.
        #[test]
        #[ignore = "пишет в хранилище ОС"]
        fn measure_max_length() {
            let p = Probe::new("length");
            let fits = |n: usize| OsKeyring.set(&p.0, &"a".repeat(n)).is_ok();
            let (mut ok, mut bad) = (1usize, 1_000_000usize);
            assert!(fits(ok));
            assert!(!fits(bad), "предел не найден до {bad} символов");
            while bad - ok > 1 {
                let mid = (ok + bad) / 2;
                if fits(mid) {
                    ok = mid;
                } else {
                    bad = mid;
                }
            }
            // принятая запись читается целиком
            assert!(fits(ok));
            assert_eq!(OsKeyring.get(&p.0).unwrap().map(|s| s.len()), Some(ok));
            // отказ по длине узнаваем по тексту, а не выглядит как сбой хранилища
            assert_eq!(OsKeyring.set(&p.0, &"a".repeat(bad)).unwrap_err(), TOO_LONG);
            println!("МАКСИМУМ ASCII-записи: {ok} символов (отказ с {bad})");
        }
    }
}
