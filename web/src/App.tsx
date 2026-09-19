import { useState } from 'react';
import Chat from './Chat';
import Dashboard from './Dashboard';
import './App.css';

export default function App() {
  const [tab, setTab] = useState<'chat' | 'dashboard'>('chat');

  return (
    <div className="app">
      <nav className="tabs">
        <button
          data-testid="tab-chat"
          className={tab === 'chat' ? 'active' : ''}
          onClick={() => setTab('chat')}
        >
          💬 Chat
        </button>
        <button
          data-testid="tab-dashboard"
          className={tab === 'dashboard' ? 'active' : ''}
          onClick={() => setTab('dashboard')}
        >
          📊 Dashboard
        </button>
      </nav>

      <main>
        {tab === 'chat' ? <Chat /> : <Dashboard />}
      </main>
    </div>
  );
}