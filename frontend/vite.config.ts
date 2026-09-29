/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// Куда dev-сервер проксирует /api. По умолчанию — бэкенд из docker-compose,
// но у каждой сессии свой стенд со своим портом (см. CLAUDE.md, «Изоляция
// работы»), и без переменной фронт можно было открыть только против одного,
// общего. Переменная задаётся при запуске: VITE_API_TARGET=http://localhost:18010
const apiTarget = process.env['VITE_API_TARGET'] ?? 'http://localhost:8000'

export default defineConfig({
  plugins: [react()],
  server: { proxy: { '/api': apiTarget } },
  test: { environment: 'jsdom', setupFiles: ['src/test-setup.ts'] },
})
