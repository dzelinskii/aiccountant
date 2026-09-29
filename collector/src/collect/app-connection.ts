/**
 * Куда и как коллектор ходит в наше приложение. Заголовок авторизации ядро не
 * толкует: приложение кладёт туда сессию человека (`Session …`).
 */
export interface AppConnection {
  /** Адрес сервера приложения, например http://localhost:18000 */
  baseUrl: string
  workspaceId: string
  /** Значение заголовка Authorization целиком. */
  authorization: string
}
