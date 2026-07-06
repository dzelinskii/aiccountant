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
}

export const getMe = () => api<Me>('/api/me')

export const login = (email: string, password: string) =>
  api<UserOut>('/api/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) })

export const register = (email: string, password: string) =>
  api<UserOut>('/api/auth/register', { method: 'POST', body: JSON.stringify({ email, password }) })

export const logout = () => api<void>('/api/auth/logout', { method: 'POST' })
