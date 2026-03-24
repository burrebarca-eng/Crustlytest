-- ============================================================
-- CRUSTLY — SUPABASE SCHEMA
-- Kör detta i Supabase SQL Editor (supabase.com → SQL Editor)
-- ============================================================

-- ── EXTENSIONS ──
create extension if not exists "uuid-ossp";

-- ============================================================
-- RESTAURANTS
-- ============================================================
create table if not exists restaurants (
  id            uuid primary key default uuid_generate_v4(),
  name          text not null,
  slug          text unique not null,
  owner_uid     uuid references auth.users(id) on delete cascade,
  owner_email   text,
  owner_name    text,
  phone         text,
  address       text,
  website       text,
  org_number    text,
  bank_account  text,
  swish_number  text,
  accent_color  text default '#f05a1a',
  logo_url      text,
  status        text default 'active', -- active | demo | inactive
  plan          text default 'bas',    -- bas | pro | premium
  campaign_budget integer default 0,
  menu          jsonb default '[]',
  opening_hours jsonb default '{}',
  settings      jsonb default '{}',
  created_at    timestamptz default now(),
  updated_at    timestamptz default now()
);

-- ============================================================
-- ORDERS
-- ============================================================
create table if not exists orders (
  id              uuid primary key default uuid_generate_v4(),
  restaurant_id   uuid references restaurants(id) on delete cascade,
  restaurant_name text,
  restaurant_slug text,
  customer_name   text,
  customer_phone  text,
  customer_email  text,
  items           jsonb default '[]',
  total           numeric(10,2) default 0,
  crustly_cut     numeric(10,2) default 0,
  delivery_type   text default 'pickup',  -- pickup | delivery
  delivery_address text,
  payment_method  text default 'swish',   -- swish | cash
  payment_status  text default 'pending', -- pending | paid | confirmed
  status          text default 'new',     -- new | preparing | ready | done | cancelled
  special_instructions text,
  swish_reference text,
  notes           text,
  created_at      timestamptz default now(),
  updated_at      timestamptz default now()
);

-- ============================================================
-- CUSTOMERS
-- ============================================================
create table if not exists customers (
  id              uuid primary key default uuid_generate_v4(),
  user_id         uuid references auth.users(id) on delete set null,
  restaurant_id   uuid references restaurants(id) on delete cascade,
  restaurant_slug text,
  name            text,
  phone           text,
  email           text,
  birthday_day    int,
  birthday_month  int,
  loyalty_points  int default 0,
  loyalty_tier    text default 'bronze', -- bronze | silver | gold
  total_orders    int default 0,
  total_spent     numeric(10,2) default 0,
  last_order_at   timestamptz,
  sms_sent        boolean default false,
  sms_sent_at     timestamptz,
  reengagement_sent_at timestamptz,
  notes           text,
  created_at      timestamptz default now(),
  updated_at      timestamptz default now()
);

-- ============================================================
-- CAMPAIGNS
-- ============================================================
create table if not exists campaigns (
  id              uuid primary key default uuid_generate_v4(),
  restaurant_id   uuid references restaurants(id) on delete cascade,
  title           text,
  message         text,
  discount        int default 0,
  type            text default 'manual', -- manual | auto | birthday | reengagement
  status          text default 'draft',  -- draft | sent | scheduled
  recipients      int default 0,
  sent_at         timestamptz,
  scheduled_for   timestamptz,
  ai_generated    boolean default false,
  created_at      timestamptz default now()
);

-- ============================================================
-- LOYALTY REWARDS
-- ============================================================
create table if not exists loyalty_rewards (
  id              uuid primary key default uuid_generate_v4(),
  restaurant_id   uuid references restaurants(id) on delete cascade,
  name            text,
  description     text,
  points_required int default 100,
  discount_value  numeric(10,2),
  active          boolean default true,
  created_at      timestamptz default now()
);

-- ============================================================
-- REPORTS (weekly summaries)
-- ============================================================
create table if not exists reports (
  id              uuid primary key default uuid_generate_v4(),
  restaurant_id   uuid references restaurants(id) on delete cascade,
  week_start      date,
  week_end        date,
  total_orders    int default 0,
  total_revenue   numeric(10,2) default 0,
  crustly_cut     numeric(10,2) default 0,
  top_items       jsonb default '[]',
  ai_summary      text,
  ai_tips         jsonb default '[]',
  sent_at         timestamptz,
  created_at      timestamptz default now()
);

-- ============================================================
-- SETTINGS (per restaurant)
-- ============================================================
create table if not exists settings (
  id              uuid primary key default uuid_generate_v4(),
  restaurant_id   uuid references restaurants(id) on delete cascade unique,
  claude_api_key  text,
  elks_api_user   text,
  elks_api_pass   text,
  sms_from        text default 'Crustly',
  birthday_enabled boolean default true,
  birthday_days_before int default 7,
  birthday_discount int default 20,
  birthday_template text,
  reengagement_enabled boolean default true,
  reengagement_days int default 14,
  reengagement_discount int default 15,
  reengagement_template text,
  loyalty_enabled boolean default true,
  points_per_kr   numeric(5,2) default 1,
  created_at      timestamptz default now(),
  updated_at      timestamptz default now()
);

-- ============================================================
-- ROW LEVEL SECURITY (RLS)
-- ============================================================

alter table restaurants    enable row level security;
alter table orders         enable row level security;
alter table customers      enable row level security;
alter table campaigns      enable row level security;
alter table loyalty_rewards enable row level security;
alter table reports        enable row level security;
alter table settings       enable row level security;

-- Restaurants: owner sees only their own
create policy "owner_restaurants" on restaurants
  for all using (owner_uid = auth.uid());

-- Orders: owner sees only their restaurant's orders
-- Public can insert (customers placing orders)
create policy "owner_orders_select" on orders
  for select using (
    restaurant_id in (
      select id from restaurants where owner_uid = auth.uid()
    )
  );
create policy "public_orders_insert" on orders
  for insert with check (true);
create policy "owner_orders_update" on orders
  for update using (
    restaurant_id in (
      select id from restaurants where owner_uid = auth.uid()
    )
  );

-- Customers: owner sees only their restaurant's customers
-- Public can insert (customers registering)
create policy "owner_customers_select" on customers
  for select using (
    restaurant_id in (
      select id from restaurants where owner_uid = auth.uid()
    )
  );
create policy "public_customers_insert" on customers
  for insert with check (true);
create policy "owner_customers_update" on customers
  for update using (
    restaurant_id in (
      select id from restaurants where owner_uid = auth.uid()
    )
  );
-- Public (order page) can update customer stats — no auth needed
create policy "public_customers_update_stats" on customers
  for update using (true)
  with check (true);

-- Campaigns, loyalty, reports, settings: owner only
create policy "owner_campaigns" on campaigns
  for all using (
    restaurant_id in (
      select id from restaurants where owner_uid = auth.uid()
    )
  );
create policy "owner_loyalty_rewards" on loyalty_rewards
  for all using (
    restaurant_id in (
      select id from restaurants where owner_uid = auth.uid()
    )
  );
create policy "owner_reports" on reports
  for all using (
    restaurant_id in (
      select id from restaurants where owner_uid = auth.uid()
    )
  );
create policy "owner_settings" on settings
  for all using (
    restaurant_id in (
      select id from restaurants where owner_uid = auth.uid()
    )
  );

-- ============================================================
-- REALTIME (för köksskärm)
-- ============================================================
alter publication supabase_realtime add table orders;
alter publication supabase_realtime add table restaurants;

-- ============================================================
-- INDEXES (prestanda)
-- ============================================================
create index if not exists idx_orders_restaurant    on orders(restaurant_id);
create index if not exists idx_orders_created       on orders(created_at desc);
create index if not exists idx_orders_status        on orders(status);
create index if not exists idx_customers_restaurant on customers(restaurant_id);
create index if not exists idx_customers_phone      on customers(phone);
create index if not exists idx_campaigns_restaurant on campaigns(restaurant_id);

-- ============================================================
-- UPDATED_AT TRIGGER
-- ============================================================
create or replace function update_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger trg_restaurants_updated
  before update on restaurants
  for each row execute function update_updated_at();

create trigger trg_orders_updated
  before update on orders
  for each row execute function update_updated_at();

create trigger trg_customers_updated
  before update on customers
  for each row execute function update_updated_at();
