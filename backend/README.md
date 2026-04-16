# Hardened Forge Backend

This backend keeps your LLM key server-side and stores shared forge results in Postgres.

## Security Model

- Browser never receives `OPENROUTER_API_KEY`
- Strict CORS (`ALLOWED_ORIGIN`)
- Optional local-file testing gate (`ALLOW_NULL_ORIGIN=true`)
- Input validation (`zod`) on every endpoint
- Rate limiting on read and generate routes
- Protected generation endpoints with `SERVER_AUTH_TOKEN`
- Cache-first lookups to reduce LLM cost and abuse surface

## Endpoints

- `GET /health`
- `POST /api/forge` -> cache lookup only
- `POST /api/forge/generate` -> token-protected generation + cache write
- `POST /api/hint` -> token-protected hint generation

## Setup

1. Create a Postgres database (Supabase is fine).
2. Run `schema.sql`.
3. Copy `.env.example` to `.env` and fill values.
4. Install deps:
   - `npm install`
5. Run:
   - `npm start`

## Frontend Integration Strategy

For maximum protection, do **not** put `SERVER_AUTH_TOKEN` in browser code.
Use one of these:

1. Add your own session/auth layer so only logged-in users can hit generate routes.
2. If you must use a static game client, use only `/api/forge` from browser and pre-seed common combinations from server scripts.

If you decide to call `/api/forge/generate` from browser anyway, treat that token as public and rotate it often.
