import RunsListPage from './pages/RunsListPage'

export default function App() {
  return (
    <div className="min-h-screen bg-neutral-950 text-neutral-100">
      <header className="border-b border-neutral-800 px-6 py-3">
        <h1 className="text-sm font-semibold tracking-wide text-neutral-300">propbt viz</h1>
      </header>
      <RunsListPage />
    </div>
  )
}
