# Shop database

`openShopDatabase()` creates/opens the local SQLite database and applies ordered, transactional migrations. Electron passes a path under `app.getPath('userData')`; this database is the shop's single source of truth. Do not open it from the renderer, mobile client, or cloud service.

The migration runner records completed versions in `schema_migrations`. Built-in currency data is seeded from `src/currency/catalog.ts`. See [`/docs/SCHEMA.md`](../../docs/SCHEMA.md) for tables, integer-minor-unit rules and the legacy setup-data import.
