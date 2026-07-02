import { render, screen } from '@testing-library/react'
import { expect, test } from 'vitest'
import App from './App'

test('показывает название и статус API', () => {
  render(<App />)
  expect(screen.getByText('AIccountant')).toBeDefined()
  expect(screen.getByText(/API/)).toBeDefined()
})
