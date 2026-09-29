/**
 * Куда и как коллектор ходит в наше приложение. Приложение предъявляет сессию
 * человека (`Session …`), CLI — API-токен (`Bearer …`); ядру разница не видна.
 */
export interface AppConnection {
  /** Адрес сервера приложения, например http://localhost:18000 */
  baseUrl: string
  workspaceId: string
  /** Значение заголовка Authorization целиком. */
  authorization: string
}
