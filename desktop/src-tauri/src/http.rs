//! Запрос к банку от имени ядра коллектора. Окно приложения само в банк не
//! ходит: помешал бы CORS, а главное — только здесь можно поставить список
//! адресов и доверие к УЦ так, чтобы скрипт окна их не обошёл.

use std::collections::HashMap;
use std::time::Duration;

use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use serde::Serialize;
use tauri::Url;

use crate::banks::{self, Bank, Trust};

const TIMEOUT: Duration = Duration::from_secs(30);

/// Заголовки, которые окну ставить нельзя. `Host` hyper подставляет сам, но
/// только если его нет: иначе скрипт отправил бы запрос на разрешённый хост
/// с чужим `Host`. Остальные — управление соединением и длиной тела, их
/// выставляет клиент, а не вызывающий.
const FORBIDDEN_HEADERS: &[&str] = &[
    "host",
    "connection",
    "keep-alive",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
    "content-length",
];

#[derive(Debug, Serialize)]
pub struct BankResponse {
    pub status: u16,
    /// Тело только у успешного ответа: тело отказа ядру не нужно, а в нём
    /// бывают данные, которые незачем тащить в окно.
    pub body: String,
}

/// Клиент под доверие банка. Редирект не проходится: 3xx возвращается ответом,
/// как и в прежних транспортах коллектора, — иначе редирект обошёл бы список.
pub fn client_for(bank: &Bank) -> Result<reqwest::Client, String> {
    let root = reqwest::Certificate::from_pem(banks::ROOT_PEM.as_bytes())
        .map_err(|e| format!("Корень УЦ не читается: {e}"))?;
    let mut builder = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(TIMEOUT)
        .add_root_certificate(root);
    if bank.trust == Trust::RootOnly {
        builder = builder.tls_built_in_root_certs(false);
    }
    builder
        .build()
        .map_err(|e| format!("HTTP-клиент не собрался: {e}"))
}

/// Заголовки из окна проходят как есть, кроме служебных (см.
/// `FORBIDDEN_HEADERS`). В тексте отказа только имя: значение — это куки
/// или токен.
fn check_headers(headers: &HashMap<String, String>) -> Result<HeaderMap, String> {
    let mut checked = HeaderMap::new();
    for (name, value) in headers {
        let lower = name.to_ascii_lowercase();
        if lower.starts_with(':')
            || lower.starts_with("proxy-")
            || FORBIDDEN_HEADERS.contains(&lower.as_str())
        {
            return Err(format!("Заголовок не разрешён: {name}"));
        }
        let invalid = || format!("Неверный заголовок: {name}");
        let header_name = HeaderName::from_bytes(name.as_bytes()).map_err(|_| invalid())?;
        let header_value = HeaderValue::from_str(value).map_err(|_| invalid())?;
        checked.append(header_name, header_value);
    }
    Ok(checked)
}

/// Тело отдаётся только у успешного ответа, у остальных — пустое.
async fn read_response(response: reqwest::Response) -> Result<BankResponse, String> {
    let status = response.status();
    let body = if status.is_success() {
        response.text().await.map_err(|e| describe(&e))?
    } else {
        String::new()
    };
    Ok(BankResponse {
        status: status.as_u16(),
        body,
    })
}

#[tauri::command]
pub async fn bank_request(
    bank: String,
    method: String,
    url: String,
    headers: HashMap<String, String>,
    body: Option<String>,
) -> Result<BankResponse, String> {
    let bank = banks::bank(&bank)?;
    let url = Url::parse(&url).map_err(|_| "Неверный адрес запроса".to_string())?;
    banks::check_request(bank, &method, &url)?;
    let method =
        reqwest::Method::from_bytes(method.as_bytes()).map_err(|_| "Неверный метод".to_string())?;
    let headers = check_headers(&headers)?;

    // Отправляется сам проверенный Url, а не его строка: проверенное и
    // отправленное совпадают без повторного разбора.
    let mut request = client_for(bank)?.request(method, url).headers(headers);
    if let Some(body) = body {
        request = request.body(body);
    }
    let response = request.send().await.map_err(|e| describe(&e))?;
    read_response(response).await
}

/// Текст ошибки reqwest несёт адрес запроса, а в адресе Т-Банка — секрет
/// сессии. Наружу уходит только вид сбоя.
fn describe(error: &reqwest::Error) -> String {
    let kind = if error.is_timeout() {
        "таймаут"
    } else if error.is_connect() {
        "нет соединения"
    } else if error.is_body() || error.is_decode() {
        "обрыв ответа"
    } else {
        "сбой запроса"
    };
    format!("Банк недоступен ({kind})")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::SocketAddr;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    /// Локальный сервер: читает запрос, отвечает заранее заданным текстом.
    async fn serve(reply: &'static str) -> SocketAddr {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut buf = [0u8; 1024];
            let _ = socket.read(&mut buf).await;
            socket.write_all(reply.as_bytes()).await.unwrap();
        });
        addr
    }

    fn headers(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    async fn get(addr: SocketAddr) -> reqwest::Response {
        let client = client_for(banks::bank("sber").unwrap()).unwrap();
        client.get(format!("http://{addr}/")).send().await.unwrap()
    }

    #[tokio::test]
    async fn not_allowed_request_never_leaves() {
        let err = bank_request(
            "tbank".into(),
            "GET".into(),
            "https://evil.example/api/common/v1/session_status".into(),
            HashMap::new(),
            None,
        )
        .await
        .unwrap_err();
        assert!(err.starts_with("Не разрешено"));
    }

    #[tokio::test]
    async fn forbidden_header_stops_allowed_request() {
        let err = bank_request(
            "tbank".into(),
            "GET".into(),
            "https://www.tbank.ru/api/common/v1/session_status".into(),
            headers(&[("Host", "evil.example")]),
            None,
        )
        .await
        .unwrap_err();
        assert!(err.starts_with("Заголовок не разрешён"));
    }

    #[test]
    fn service_headers_are_rejected_by_name_only() {
        for name in [
            "Host",
            "host",
            "HOST",
            "Content-Length",
            "content-length",
            ":authority",
            ":path",
            "Connection",
            "Keep-Alive",
            "Proxy-Authorization",
            "proxy-connection",
            "TE",
            "Trailer",
            "Transfer-Encoding",
            "Upgrade",
        ] {
            let err = check_headers(&headers(&[(name, "secret-value")])).unwrap_err();
            assert!(err.starts_with("Заголовок не разрешён"), "{name}: {err}");
            assert!(err.contains(name), "{name}: {err}");
            assert!(!err.contains("secret-value"), "{name}: {err}");
        }
    }

    #[test]
    fn collector_headers_pass() {
        let checked = check_headers(&headers(&[
            ("Accept", "application/json"),
            ("Content-Type", "application/json"),
            ("Cookie", "a=b"),
            ("X-XSRF-TOKEN", "t"),
        ]))
        .unwrap();
        assert_eq!(checked.len(), 4);
        assert_eq!(checked["cookie"], "a=b");
        assert_eq!(checked["x-xsrf-token"], "t");
    }

    #[test]
    fn malformed_header_is_rejected_without_value() {
        let err = check_headers(&headers(&[("Cookie", "a\r\nHost: evil")])).unwrap_err();
        assert_eq!(err, "Неверный заголовок: Cookie");
        assert!(check_headers(&headers(&[("bad name", "v")])).is_err());
    }

    #[tokio::test]
    async fn redirect_is_returned_not_followed() {
        let addr = serve(
            "HTTP/1.1 302 Found\r\nLocation: http://evil.example/\r\nContent-Length: 0\r\n\r\n",
        )
        .await;
        assert_eq!(get(addr).await.status().as_u16(), 302);
    }

    #[tokio::test]
    async fn refusal_body_is_not_returned() {
        let addr = serve("HTTP/1.1 403 Forbidden\r\nContent-Length: 11\r\n\r\nsecret-body").await;
        let resp = read_response(get(addr).await).await.unwrap();
        assert_eq!(resp.status, 403);
        assert_eq!(resp.body, "");
    }

    #[tokio::test]
    async fn success_body_is_returned_whole() {
        let addr = serve("HTTP/1.1 200 OK\r\nContent-Length: 11\r\n\r\n{\"ok\":true}").await;
        let resp = read_response(get(addr).await).await.unwrap();
        assert_eq!(resp.status, 200);
        assert_eq!(resp.body, "{\"ok\":true}");
    }

    #[tokio::test]
    async fn connect_error_hides_address_and_secret() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        let client = client_for(banks::bank("sber").unwrap()).unwrap();
        let err = client
            .get(format!("http://127.0.0.1:{port}/x?sessionid=SECRET"))
            .send()
            .await
            .unwrap_err();
        let text = describe(&err);
        assert_eq!(text, "Банк недоступен (нет соединения)");
        assert!(!text.contains("SECRET") && !text.contains("127.0.0.1"));
    }

    #[tokio::test]
    async fn silent_server_is_described_as_timeout() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let (_socket, _) = listener.accept().await.unwrap();
            tokio::time::sleep(Duration::from_secs(5)).await;
        });
        let client = reqwest::Client::builder()
            .timeout(Duration::from_millis(200))
            .build()
            .unwrap();
        let err = client
            .get(format!("http://{addr}/x?sessionid=SECRET"))
            .send()
            .await
            .unwrap_err();
        assert_eq!(describe(&err), "Банк недоступен (таймаут)");
    }
}
