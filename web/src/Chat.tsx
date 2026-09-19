import { useState } from 'react';

interface Message {
  role: 'user' | 'agent';
  content: string;
}

export default function Chat() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [clientId] = useState(`client-${Date.now()}`);

  const send = async () => {
    if (!input.trim() || loading) return;

    const userMessage: Message = { role: 'user', content: input };
    setMessages((prev) => [...prev, userMessage]);
    setInput('');
    setLoading(true);

    try {
      const res = await fetch('http://localhost:3000/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: input, clientId }),
      });
      const data = await res.json();

      const agentMessage: Message = {
        role: 'agent',
        content: data.response || 'Erreur : pas de réponse',
      };
      setMessages((prev) => [...prev, agentMessage]);
    } catch (e) {
      setMessages((prev) => [
        ...prev,
        { role: 'agent', content: `Erreur réseau : ${e}` },
      ]);
    } finally {
      setLoading(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  return (
    <div className="chat">
      <div className="messages" data-testid="messages-container">
        {messages.map((m, i) => (
          <div
            key={i}
            data-testid={m.role === 'user' ? 'message-user' : 'message-agent'}
            className={`message ${m.role}`}
          >
            {m.content}
          </div>
        ))}
        {loading && (
          <div data-testid="loading-indicator" className="message agent">
            Kenza écrit...
          </div>
        )}
      </div>

      <div className="input-area">
        <input
          data-testid="chat-input"
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Tape ton message en darija..."
          disabled={loading}
        />
        <button
          data-testid="send-button"
          onClick={send}
          disabled={loading || !input.trim()}
        >
          Envoyer
        </button>
      </div>
    </div>
  );
}