create table if not exists forge_results (
  id bigint generated always as identity primary key,
  pair_key text not null unique,
  dao_a text not null,
  dao_b text not null,
  tier int not null check (tier between 1 and 9),
  result_json jsonb not null,
  generated_by_ip_hash text,
  created_at timestamptz not null default now()
);

create index if not exists forge_results_created_at_idx on forge_results (created_at desc);
