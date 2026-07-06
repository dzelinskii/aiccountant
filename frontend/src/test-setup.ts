import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'

// @testing-library/react полагается на глобальный afterEach (доступен только
// при test.globals: true), которого в этом проекте нет — размонтируем компоненты
// между тестами явно, иначе DOM от предыдущих тестов накапливается.
afterEach(() => {
  cleanup()
})

if (!window.matchMedia) {
  window.matchMedia = (query: string): MediaQueryList =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }) as MediaQueryList
}

if (!window.ResizeObserver) {
  window.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
}
