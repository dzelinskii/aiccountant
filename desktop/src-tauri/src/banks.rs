//! Банки, с которыми говорит оболочка: куда разрешено ходить и чему доверять.
//! Слова банков живут здесь и в плагинах коллектора — дальше они не уходят.

use tauri::Url;

/// Корень УЦ Минцифры. Доверие держится на его отпечатке, который сверяет тест.
pub const ROOT_PEM: &str = include_str!("../russian_trusted_root_ca.pem");
/// SPKI-отпечаток того же корня — им окно входа закрепляет УЦ.
pub const ROOT_SPKI_SHA256: &str = "ArgiDAcHKNt3HZrFnlRSHE7drSGng7smz98ZwdsPrjc=";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Trust {
    /// Только корень Минцифры: домен банка выпущен одним этим УЦ.
    RootOnly,
    /// Системный набор плюс корень Минцифры: банк отдаёт цепочку Минцифры
    /// (замер 2026-09-29), а отдаёт ли кому-то прежнюю — не проверено.
    SystemAndRoot,
}

pub struct Bank {
    pub code: &'static str,
    /// Хост API: запросы коллектора уходят только сюда.
    pub api_host: &'static str,
    /// Домен окна входа: вход проходит по поддоменам (Альфа уводит на
    /// private.auth.alfabank.ru), поэтому граница — домен, а не хост.
    pub domain: &'static str,
    /// Пары «метод, путь» — весь набор возможностей коллектора по банку.
    pub allowed: &'static [(&'static str, &'static str)],
    pub trust: Trust,
}

pub const BANKS: &[Bank] = &[
    Bank {
        code: "tbank",
        api_host: "www.tbank.ru",
        domain: "tbank.ru",
        allowed: &[
            ("GET", "/api/common/v1/accounts_light_ib"),
            ("GET", "/api/common/v1/session_status"),
            (
                "GET",
                "/mybank/api/operations/timeline/public/legacy/v1/operations",
            ),
            (
                "GET",
                "/mybank/api/operations/timeline/public/legacy/v1/operations_category_list_bank",
            ),
            (
                "GET",
                "/mybank/api/operations/timeline/public/legacy/v1/operations_category_list_user",
            ),
        ],
        trust: Trust::SystemAndRoot,
    },
    Bank {
        code: "sber",
        api_host: "web-node3.online.sberbank.ru",
        domain: "sberbank.ru",
        // Сбер отдаёт данные по POST: метод здесь безвредности не доказывает,
        // гарантия — сам список, и все три адреса читающие
        allowed: &[
            ("POST", "/uoh-bh/v1/operations/list"),
            ("POST", "/main-screen/rest/v2/m1/web/section/meta"),
            ("POST", "/ufs-carddetail/rest/card/v1/cardInfo"),
        ],
        trust: Trust::RootOnly,
    },
    Bank {
        code: "alfa",
        api_host: "web.alfabank.ru",
        domain: "alfabank.ru",
        allowed: &[
            ("POST", "/api/v1/operations-history/operations"),
            ("GET", "/api/v1/account/"),
            ("GET", "/api/v1/cards/masked-cards"),
        ],
        trust: Trust::RootOnly,
    },
];

pub fn bank(code: &str) -> Result<&'static Bank, String> {
    BANKS
        .iter()
        .find(|b| b.code == code)
        .ok_or_else(|| format!("Неизвестный банк: {code}"))
}

/// Адрес без порта и без учётных данных: и запрос, и страница входа должны
/// идти на сам хост, а не на `user@host` или нестандартный порт.
fn is_plain_authority(url: &Url) -> bool {
    url.port().is_none() && url.username().is_empty() && url.password().is_none()
}

/// Запрос разрешён, только если совпало всё сразу: https, хост API банка без
/// порта и учётных данных, пара «метод, путь» из списка. Query не проверяется:
/// в нём параметры и у Т-Банка секрет сессии; в текст отказа он не попадает.
pub fn check_request(bank: &Bank, method: &str, url: &Url) -> Result<(), String> {
    let allowed = url.scheme() == "https"
        && url.host_str() == Some(bank.api_host)
        && is_plain_authority(url)
        && bank
            .allowed
            .iter()
            .any(|(m, p)| *m == method && *p == url.path());
    if allowed {
        Ok(())
    } else {
        Err(format!(
            "Не разрешено: {} {} {}",
            bank.code,
            method,
            url.path()
        ))
    }
}

/// Страница, куда окно входа банка может перейти по нашей команде.
pub fn is_bank_page(bank: &Bank, url: &Url) -> bool {
    url.scheme() == "https"
        && is_plain_authority(url)
        && url
            .host_str()
            .is_some_and(|host| host == bank.domain || host.ends_with(&format!(".{}", bank.domain)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine;
    use sha2::{Digest, Sha256};

    fn url(s: &str) -> Url {
        Url::parse(s).unwrap()
    }

    #[test]
    fn allowed_endpoint_passes() {
        let tbank = bank("tbank").unwrap();
        assert!(check_request(
            tbank,
            "GET",
            &url("https://www.tbank.ru/api/common/v1/session_status?sessionid=x")
        )
        .is_ok());
    }

    #[test]
    fn foreign_path_method_host_rejected() {
        let sber = bank("sber").unwrap();
        let ok = "https://web-node3.online.sberbank.ru/uoh-bh/v1/operations/list";
        assert!(check_request(sber, "POST", &url(ok)).is_ok());
        assert!(check_request(sber, "GET", &url(ok)).is_err(), "чужой метод");
        assert!(
            check_request(
                sber,
                "POST",
                &url("https://web-node3.online.sberbank.ru/uoh-bh/v1/operations/delete")
            )
            .is_err(),
            "чужой путь"
        );
        assert!(
            check_request(
                sber,
                "POST",
                &url("https://evil.example/uoh-bh/v1/operations/list")
            )
            .is_err(),
            "чужой хост"
        );
        assert!(
            check_request(
                sber,
                "POST",
                &url("http://web-node3.online.sberbank.ru/uoh-bh/v1/operations/list")
            )
            .is_err(),
            "не https"
        );
        assert!(
            check_request(
                sber,
                "POST",
                &url("https://web-node3.online.sberbank.ru:8443/uoh-bh/v1/operations/list")
            )
            .is_err(),
            "чужой порт"
        );
        assert!(
            check_request(
                sber,
                "POST",
                &url("https://u:p@web-node3.online.sberbank.ru/uoh-bh/v1/operations/list")
            )
            .is_err(),
            "учётные данные в адресе"
        );
    }

    #[test]
    fn one_bank_cannot_reach_another() {
        // путь взят из списка Альфы, но хост чужой: отказать должна именно
        // проверка хоста, а не то, что такого пути нет у Т-Банка
        let alfa = bank("alfa").unwrap();
        assert!(
            check_request(alfa, "GET", &url("https://web.alfabank.ru/api/v1/account/")).is_ok()
        );
        assert!(check_request(alfa, "GET", &url("https://www.tbank.ru/api/v1/account/")).is_err());
    }

    #[test]
    fn continuation_of_allowed_path_rejected() {
        // путь сравнивается целиком, а не по началу
        let sber = bank("sber").unwrap();
        for tail in ["/delete", "X", "/"] {
            let address = url(&format!(
                "https://web-node3.online.sberbank.ru/uoh-bh/v1/operations/list{tail}"
            ));
            assert!(check_request(sber, "POST", &address).is_err(), "{tail}");
        }
        let alfa = bank("alfa").unwrap();
        let address = url("https://web.alfabank.ru/api/v1/account/x");
        assert!(check_request(alfa, "GET", &address).is_err());
    }

    #[test]
    fn bank_lists_are_pinned() {
        // весь набор возможностей коллектора виден литералом: правка списка,
        // хоста или домена без правки этого теста не пройдёт
        type Expected = (
            &'static str,
            &'static str,
            &'static str,
            &'static [(&'static str, &'static str)],
        );
        let expected: [Expected; 3] = [
            (
                "tbank",
                "www.tbank.ru",
                "tbank.ru",
                &[
                    ("GET", "/api/common/v1/accounts_light_ib"),
                    ("GET", "/api/common/v1/session_status"),
                    ("GET", "/mybank/api/operations/timeline/public/legacy/v1/operations"),
                    (
                        "GET",
                        "/mybank/api/operations/timeline/public/legacy/v1/operations_category_list_bank",
                    ),
                    (
                        "GET",
                        "/mybank/api/operations/timeline/public/legacy/v1/operations_category_list_user",
                    ),
                ],
            ),
            (
                "sber",
                "web-node3.online.sberbank.ru",
                "sberbank.ru",
                &[
                    ("POST", "/uoh-bh/v1/operations/list"),
                    ("POST", "/main-screen/rest/v2/m1/web/section/meta"),
                    ("POST", "/ufs-carddetail/rest/card/v1/cardInfo"),
                ],
            ),
            (
                "alfa",
                "web.alfabank.ru",
                "alfabank.ru",
                &[
                    ("POST", "/api/v1/operations-history/operations"),
                    ("GET", "/api/v1/account/"),
                    ("GET", "/api/v1/cards/masked-cards"),
                ],
            ),
        ];
        assert_eq!(BANKS.len(), expected.len());
        for (code, api_host, domain, allowed) in expected {
            let b = bank(code).unwrap();
            assert_eq!(b.api_host, api_host, "{code}: хост API");
            assert_eq!(b.domain, domain, "{code}: домен входа");
            assert_eq!(b.allowed, allowed, "{code}: список адресов");
        }
    }

    #[test]
    fn login_domain_is_not_too_wide() {
        for b in BANKS {
            // зона вроде «ru» не должна оказаться доменом банка
            let zone = b.domain.rsplit('.').next().unwrap();
            let evil = url(&format!("https://evil.{zone}/"));
            assert!(!is_bank_page(b, &evil), "{}: {evil}", b.code);
            assert!(is_bank_page(b, &url(&format!("https://{}/", b.api_host))));
            // хост API одного банка не страница другого
            for other in BANKS.iter().filter(|o| o.code != b.code) {
                let foreign = url(&format!("https://{}/", other.api_host));
                assert!(!is_bank_page(b, &foreign), "{} -> {}", other.code, b.code);
            }
        }
    }

    #[test]
    fn rejection_does_not_leak_query() {
        let tbank = bank("tbank").unwrap();
        let err = check_request(
            tbank,
            "POST",
            &url("https://www.tbank.ru/api/common/v1/session_status?sessionid=SECRET"),
        )
        .unwrap_err();
        assert!(!err.contains("SECRET"));
    }

    #[test]
    fn unknown_bank_rejected() {
        assert!(bank("toString").is_err());
    }

    #[test]
    fn trust_per_bank() {
        assert_eq!(bank("sber").unwrap().trust, Trust::RootOnly);
        assert_eq!(bank("alfa").unwrap().trust, Trust::RootOnly);
        assert_eq!(bank("tbank").unwrap().trust, Trust::SystemAndRoot);
    }

    #[test]
    fn login_pages_stay_on_bank_domain() {
        let alfa = bank("alfa").unwrap();
        assert!(is_bank_page(
            alfa,
            &url("https://private.auth.alfabank.ru/passport/x")
        ));
        assert!(is_bank_page(alfa, &url("https://alfabank.ru/")));
        assert!(!is_bank_page(
            alfa,
            &url("https://alfabank.ru.evil.example/")
        ));
        assert!(!is_bank_page(alfa, &url("https://notalfabank.ru/")));
        assert!(!is_bank_page(alfa, &url("http://web.alfabank.ru/")));
    }

    #[test]
    fn real_login_addresses_pass() {
        // адреса из LOGIN_URL, MYBANK_URL и COOKIE_ORIGIN плагинов коллектора
        let cases = [
            ("tbank", "https://www.tbank.ru/login/"),
            ("tbank", "https://www.tbank.ru/mybank/"),
            ("sber", "https://online.sberbank.ru/"),
            ("sber", "https://web-node3.online.sberbank.ru/"),
            ("alfa", "https://web.alfabank.ru/"),
        ];
        for (code, address) in cases {
            assert!(
                is_bank_page(bank(code).unwrap(), &url(address)),
                "{address}"
            );
        }
    }

    #[test]
    fn url_normalization_cannot_smuggle_a_path_or_host() {
        // Url сворачивает «..» до проверки, поэтому список сверяется с тем
        // путём, который реально уйдёт в сеть, а не с тем, что написано в строке
        let tbank = bank("tbank").unwrap();
        let operations = "/mybank/api/operations/timeline/public/legacy/v1/operations";
        let via_dots = url(&format!(
            "https://www.tbank.ru/api/common/v1/../../..{operations}"
        ));
        assert_eq!(via_dots.path(), operations);
        let foreign = url("https://www.tbank.ru/api/common/v1/../../v2/admin");
        assert!(check_request(tbank, "GET", &foreign).is_err());
        // хост с точкой на конце — другое имя для резолвера и сертификата: не пускаем
        let dotted = url("https://www.tbank.ru./api/common/v1/session_status");
        assert!(check_request(tbank, "GET", &dotted).is_err());
        // закодированный слэш не превращается в разделитель пути
        let encoded = url("https://www.tbank.ru/api/common/v1%2Fsession_status");
        assert!(check_request(tbank, "GET", &encoded).is_err());
    }

    #[test]
    fn credentials_in_address_rejected_in_each_form() {
        let tbank = bank("tbank").unwrap();
        let path = "www.tbank.ru/api/common/v1/session_status";
        for authority in ["u@", ":p@", "u:p@"] {
            let address = url(&format!("https://{authority}{path}"));
            assert!(
                check_request(tbank, "GET", &address).is_err(),
                "{authority}"
            );
        }
    }

    #[test]
    fn method_is_case_sensitive() {
        // в reqwest метод регистрозависим, а «get» — не тот же метод, что «GET»:
        // команда отправки не должна приводить регистр молча
        let tbank = bank("tbank").unwrap();
        let address = url("https://www.tbank.ru/api/common/v1/session_status");
        assert!(check_request(tbank, "GET", &address).is_ok());
        assert!(check_request(tbank, "get", &address).is_err());
    }

    #[test]
    fn login_page_rejects_port_and_credentials() {
        let alfa = bank("alfa").unwrap();
        assert!(!is_bank_page(alfa, &url("https://web.alfabank.ru:8443/")));
        assert!(!is_bank_page(alfa, &url("https://u:p@web.alfabank.ru/")));
        assert!(!is_bank_page(alfa, &url("https://u@web.alfabank.ru/")));
    }

    fn root_der() -> Vec<u8> {
        let body: String = ROOT_PEM
            .lines()
            .filter(|l| !l.starts_with("-----"))
            .collect();
        base64::engine::general_purpose::STANDARD
            .decode(body)
            .unwrap()
    }

    /// Разбирает один DER-элемент: (он целиком, содержимое, остаток за ним).
    fn read_tlv(input: &[u8]) -> (&[u8], &[u8], &[u8]) {
        let (len, header) = if input[1] < 0x80 {
            (usize::from(input[1]), 2)
        } else {
            let n = usize::from(input[1] & 0x7f);
            let len = input[2..2 + n]
                .iter()
                .fold(0, |acc, b| (acc << 8) | usize::from(*b));
            (len, 2 + n)
        };
        let end = header + len;
        (&input[..end], &input[header..end], &input[end..])
    }

    #[test]
    fn root_is_the_mincifry_root() {
        // отпечаток корня, опубликованного Минцифрой: файл, не совпавший с ним,
        // доверенным стать не должен
        let hex: String = Sha256::digest(root_der())
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();
        assert_eq!(
            hex,
            "d26d2d0231b7c39f92cc738512ba54103519e4405d68b5bd703e9788ca8ecf31"
        );
    }

    #[test]
    fn spki_pin_matches_the_root() {
        // Certificate -> tbsCertificate -> [0] version, затем serialNumber,
        // signature, issuer, validity, subject и наконец subjectPublicKeyInfo
        let der = root_der();
        let (_, certificate, _) = read_tlv(&der);
        let (_, tbs, _) = read_tlv(certificate);
        let (_, _, mut rest) = read_tlv(tbs);
        for _ in 0..5 {
            rest = read_tlv(rest).2;
        }
        let (spki, _, _) = read_tlv(rest);
        let pin = base64::engine::general_purpose::STANDARD.encode(Sha256::digest(spki));
        assert_eq!(pin, ROOT_SPKI_SHA256);
    }
}
