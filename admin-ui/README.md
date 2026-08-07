# uNetWatch — Admin Console

The web admin UI for the uNetWatch project. Built with React + TypeScript,
Vite, Tailwind CSS v4, and Radix UI primitives (no external CDN).

## Development

```bash
npm install
npm run dev          # dev server on :5173, proxies /api -> http://localhost:8000
```

Keep the FastAPI backend running on `:8000` for API access.

## Production build

```bash
npm run build        # outputs to dist/
cd ..
uvicorn app.main:app --port 8000   # serves dist/ at /
```

The FastAPI app automatically serves the built frontend from `dist/` at `/` when
it exists.

## Structure

- `src/App.tsx` — dashboard + navigation
- `src/components/PatternTable.tsx` — pattern CRUD table
- `src/components/ui.tsx` — shadcn-style UI primitives
- `src/api.ts` — typed API client for the backend
- `src/lib/` — utilities
