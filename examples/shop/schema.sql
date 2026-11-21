CREATE TABLE customers (
  id bigint PRIMARY KEY,
  email text NOT NULL
);
CREATE TABLE orders (
  id bigserial PRIMARY KEY,
  customer_id integer NOT NULL,
  status text NOT NULL DEFAULT 'new',
  total numeric(12,2) NOT NULL,
  note text,
  created_at timestamptz NOT NULL DEFAULT now()
);
