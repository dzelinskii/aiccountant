import { clearSession, saveSession } from '../desktop/connection'
import { isDesktop } from '../desktop/runtime'
import { api } from './client'

export interface Workspace {
  id: string
  name: string
  role: string
}

export interface Me {
  id: string
  email: string
  workspaces: Workspace[]
}

export interface UserOut {
  id: string
  email: string
  // приходит только приложению (client: 'app'); браузеру хватает cookie
  session_token: string | null
}

export const getMe = () => api<Me>('/api/me')

async function enter(path: string, email: string, password: string): Promise<UserOut> {
  const client = isDesktop() ? 'app' : 'browser'
  const user = await api<UserOut>(path, {
    method: 'POST',
    body: JSON.stringify({ email, password, client }),
  })
  if (client === 'app') {
    // без токена приложение осталось бы без сессии при «успешном» входе
    if (!user.session_token) throw new Error('Сервер не выдал сессию приложению')
    await saveSession(user.session_token)
  }
  return user
}

export const login = (email: string, password: string) => enter('/api/auth/login', email, password)

export const register = (email: string, password: string) =>
  enter('/api/auth/register', email, password)

export async function logout(): Promise<void> {
  try {
    await api<void>('/api/auth/logout', { method: 'POST' })
  } finally {
    // человек отказался от сессии на этом устройстве, и ответ сервера этого не
    // отменяет: если сервер её не удалил, она доживёт до срока, но предъявить
    // её отсюда уже нечем
    if (isDesktop()) await clearSession()
  }
}
