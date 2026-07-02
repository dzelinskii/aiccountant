import { useEffect, useState } from 'react'

export default function App() {
  const [status, setStatus] = useState('…')

  useEffect(() => {
    fetch('/api/health')
      .then((r) => r.json())
      .then((d) => setStatus(d.status))
      .catch(() => setStatus('недоступен'))
  }, [])

  return (
    <main>
      <h1>AIccountant</h1>
      <p>API: {status}</p>
    </main>
  )
}
