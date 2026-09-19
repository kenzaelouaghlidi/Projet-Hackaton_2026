import { useEffect, useState } from 'react';

interface Stats {
  conversations_count: number;
  orders_count: number;
  escalations_count: number;
  conversion_rate: number;
}

export default function Dashboard() {
  const [stats, setStats] = useState<Stats>({
    conversations_count: 0,
    orders_count: 0,
    escalations_count: 0,
    conversion_rate: 0,
  });

  useEffect(() => {
    fetch('http://localhost:3000/dashboard/stats')
      .then((r) => r.json())
      .then(setStats)
      .catch(() => {});
  }, []);

  return (
    <div className="dashboard">
      <h1>📊 Tableau de bord</h1>

      <div className="stats-grid">
        <div className="stat-card">
          <div className="stat-label">Conversations</div>
          <div data-testid="conversations-count" className="stat-value">
            {stats.conversations_count}
          </div>
        </div>

        <div className="stat-card">
          <div className="stat-label">Commandes</div>
          <div data-testid="orders-count" className="stat-value">
            {stats.orders_count}
          </div>
        </div>

        <div className="stat-card">
          <div className="stat-label">Escalades</div>
          <div data-testid="escalations-count" className="stat-value">
            {stats.escalations_count}
          </div>
        </div>

        <div className="stat-card">
          <div className="stat-label">Taux de conversion</div>
          <div data-testid="conversion-rate" className="stat-value">
            {stats.conversion_rate}%
          </div>
        </div>
      </div>

      <div className="escalations-section">
        <button data-testid="tab-escalations">🚨 Voir les escalades</button>
      </div>
    </div>
  );
}