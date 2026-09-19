-- ═══════════════════════════════════════════════════════════════
-- KENZA — Schéma v2 (adapté aux données réelles du hackathon)
-- ═══════════════════════════════════════════════════════════════

-- Nettoyer les anciennes tables
DROP TABLE IF EXISTS escalations CASCADE;
DROP TABLE IF EXISTS followups CASCADE;
DROP TABLE IF EXISTS orders CASCADE;
DROP TABLE IF EXISTS conversations CASCADE;
DROP TABLE IF EXISTS historical_conversations CASCADE;
DROP TABLE IF EXISTS customers CASCADE;
DROP TABLE IF EXISTS products CASCADE;
DROP TABLE IF EXISTS policies CASCADE;
DROP TABLE IF EXISTS delivery_grid CASCADE;
DROP TABLE IF EXISTS promotions CASCADE;

-- ═══ Produits (80 références) ═══
CREATE TABLE products (
  ref VARCHAR(20) PRIMARY KEY,
  modele VARCHAR(255) NOT NULL,
  famille VARCHAR(100),
  genre VARCHAR(20),
  couleur VARCHAR(50),
  taille VARCHAR(20),
  matiere VARCHAR(50),
  saison VARCHAR(50),
  prix_mad DECIMAL(10,2) NOT NULL,
  stock INTEGER NOT NULL DEFAULT 0,
  delai_reassort_jours INTEGER,
  code_barre VARCHAR(20),
  poids_g INTEGER,
  embedding VECTOR(512),
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_products_embedding ON products USING hnsw (embedding vector_cosine_ops);
CREATE INDEX idx_products_famille ON products(famille);

-- ═══ Clients (120) ═══
CREATE TABLE customers (
  client_id VARCHAR(20) PRIMARY KEY,
  nom VARCHAR(255),
  telephone VARCHAR(20) UNIQUE,
  ville VARCHAR(100),
  langue_preferee VARCHAR(10),
  premier_achat DATE,
  nb_commandes INTEGER DEFAULT 0,
  segment VARCHAR(20),
  preferences JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ═══ Commandes (320) ═══
CREATE TABLE orders (
  commande_id VARCHAR(20) PRIMARY KEY,
  client_id VARCHAR(20) REFERENCES customers(client_id),
  date DATE,
  canal VARCHAR(20),
  statut VARCHAR(30),
  total_articles_mad DECIMAL(10,2),
  frais_livraison_mad DECIMAL(10,2),
  total_mad DECIMAL(10,2),
  ville_livraison VARCHAR(100),
  paiement VARCHAR(50),
  items JSONB DEFAULT '[]',
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_orders_client ON orders(client_id);
CREATE INDEX idx_orders_date ON orders(date);

-- ═══ Grille de livraison (12 villes) ═══
CREATE TABLE delivery_grid (
  ville VARCHAR(100) PRIMARY KEY,
  frais_mad INTEGER NOT NULL,
  delai_heures INTEGER NOT NULL,
  paiement_a_la_livraison BOOLEAN DEFAULT FALSE,
  retrait_boutique BOOLEAN DEFAULT FALSE
);

-- ═══ Promotions (12 promos) ═══
CREATE TABLE promotions (
  ref VARCHAR(20) REFERENCES products(ref),
  modele VARCHAR(255),
  prix_normal_mad DECIMAL(10,2),
  prix_promo_mad DECIMAL(10,2),
  debut DATE,
  fin DATE,
  condition TEXT,
  PRIMARY KEY (ref, debut)
);

-- ═══ Conversations historiques (40) ═══
CREATE TABLE historical_conversations (
  id VARCHAR(20) PRIMARY KEY,
  intention VARCHAR(50),
  langue VARCHAR(10),
  difficulte VARCHAR(20),
  client_id VARCHAR(20),
  telephone VARCHAR(20),
  ville VARCHAR(100),
  canal VARCHAR(20),
  tours JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ═══ Conversations actives ═══
CREATE TABLE conversations (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  client_id VARCHAR(20),
  channel VARCHAR(20) DEFAULT 'web_simulator',
  status VARCHAR(50) DEFAULT 'active',
  messages JSONB[] DEFAULT '{}',
  intent_history TEXT[] DEFAULT '{}',
  started_at TIMESTAMPTZ DEFAULT NOW(),
  ended_at TIMESTAMPTZ
);

-- ═══ Escalades ═══
CREATE TABLE escalations (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  conversation_id UUID,
  client_id VARCHAR(20),
  reason VARCHAR(100),
  context JSONB,
  status VARCHAR(50) DEFAULT 'pending',
  assigned_to VARCHAR(255),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  resolved_at TIMESTAMPTZ
);

-- ═══ Relances ═══
CREATE TABLE followups (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  client_id VARCHAR(20),
  conversation_id UUID,
  cart_snapshot JSONB,
  scheduled_at TIMESTAMPTZ,
  sent_at TIMESTAMPTZ,
  message_variant VARCHAR(10),
  converted BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ═══ Politiques (RAG) ═══
CREATE TABLE policies (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  category VARCHAR(100),
  title VARCHAR(255),
  content TEXT,
  embedding VECTOR(512),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_policies_embedding ON policies USING hnsw (embedding vector_cosine_ops);