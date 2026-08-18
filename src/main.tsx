import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './styles.css'

class AppErrorBoundary extends React.Component<React.PropsWithChildren, { failed: boolean }> {
  state = { failed: false }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  componentDidCatch(error: Error) {
    console.error('H3 Studio UI error', error)
  }

  render() {
    if (this.state.failed) {
      return (
        <main className="fatal-shell">
          <section className="fatal-card">
            <span>H3</span>
            <h1>页面需要重新连接</h1>
            <p>任务仍保存在服务器，刷新后会自动恢复。</p>
            <button onClick={() => window.location.reload()}>重新连接</button>
          </section>
        </main>
      )
    }
    return this.props.children
  }
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <AppErrorBoundary><App /></AppErrorBoundary>
  </React.StrictMode>,
)
