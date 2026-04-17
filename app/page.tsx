export default function Home() {
  return (
    <div style={{ fontFamily: 'system-ui', padding: '40px', textAlign: 'center', color: '#666' }}>
      <h1>InOut API</h1>
      <p>Backend compartido para InOut Media</p>
      <p style={{ fontSize: '14px', marginTop: '20px' }}>
        <a href="/api/health" style={{ color: '#00d4ff' }}>Health check →</a>
      </p>
    </div>
  )
}
