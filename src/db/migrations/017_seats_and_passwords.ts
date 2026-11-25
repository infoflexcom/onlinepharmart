import type Database from 'better-sqlite3'

/**
 * Team size: the seats a shop's licence entitles it to, and the state of each named seat.
 *
 * The brief asks the Admin to choose "how many ACCOUNT, USER and SUPERVISOR accounts to allow", to have that many
 * seats created in a "needs password" state, to be able to change the counts later, and to be prevented from dropping
 * below the number of active accounts or rising above the licence's caps.
 *
 * Migration 16 already created `role_seats` with a count per role. That table is reused, not replaced. What is added
 * here is the per-seat state that makes "needs password" a real condition rather than a guess:
 *
 * - `seat_no` already exists on `users` (migration 16) and is what ties an account to a seat.
 * - `password_set_at` distinguishes "a seat exists and cannot sign in" from "a person may sign in". A seat without a
 *   password is a real row in `users`, not a placeholder, because the Admin has to be able to name it, and because a
 *   seat that only became a row on activation would be a second source of truth for how many accounts exist.
 * - `licence_seat_caps` records the caps the licence named, so the Admin's screen can explain *which* cap stopped
 *   them rather than refusing with a bare sentence.
 *
 * The `users` row is rebuilt once more here only to add `password_set_at`; every other column, index and row is
 * carried across unchanged, exactly as migration 16 did.
 */
export function migrateSeatsAndPasswords(database: Database.Database): void {
  database.exec(`
    -- ── users: distinguish a named seat from an account somebody can actually sign in as ──────────────
    ALTER TABLE users ADD COLUMN password_set_at TEXT;

    -- Every existing row already has a usable password hash, so it is already "set". Recording that here is what
    -- stops an upgraded shop from being told to set passwords for accounts that have them.
    UPDATE users SET password_set_at = COALESCE(created_at, CURRENT_TIMESTAMP) WHERE password_hash IS NOT NULL;

    -- ── role_seats: the caps the licence named, so the screen can say which cap refused ──────────────
    -- NULL means "no cap from the licence", which is not the same as zero: zero would forbid the role entirely.
    ALTER TABLE role_seats ADD COLUMN licence_cap INTEGER;
    ALTER TABLE role_seats ADD COLUMN updated_by TEXT REFERENCES users(id);

    -- One Admin by default, as the brief requires. Re-asserted here so a database created before this migration
    -- and one created after agree; the migration is idempotent on the row itself.
    UPDATE role_seats SET seats = 1 WHERE role = 'ADMIN' AND seats < 1;

    -- ── Seat number uniqueness is per active account, which migration 16 already enforced. ────────────
    -- A seat with no password is inactive for sign-in but must still be findable by number, so the lookup is added.
    CREATE INDEX IF NOT EXISTS idx_users_seat_lookup ON users(seat_no) WHERE seat_no IS NOT NULL;

    -- ── Settings the brief lists on this screen ───────────────────────────────────────────────────────
    -- "Supervisor can see cost" is a global toggle, default OFF, and "One active login per account" is default ON.
    -- Both are operational settings, so they live on the single settings row rather than in a new table.
    ALTER TABLE settings ADD COLUMN supervisor_sees_cost INTEGER NOT NULL DEFAULT 0
      CHECK (supervisor_sees_cost IN (0, 1));
    ALTER TABLE settings ADD COLUMN single_login_per_account INTEGER NOT NULL DEFAULT 1
      CHECK (single_login_per_account IN (0, 1));
    -- "Allow Admin sign-in on client PCs", default OFF. The Server always accepts the Admin; this governs clients.
    ALTER TABLE settings ADD COLUMN allow_admin_on_clients INTEGER NOT NULL DEFAULT 0
      CHECK (allow_admin_on_clients IN (0, 1));
    -- ── The Admin's approval PIN ──────────────────────────────────────────────────────────────────────
    -- The brief: "The Admin must store a hashed approval PIN". Migration 13 recorded only *whether* a PIN is required
    -- and how long it is, which cannot approve anything — the PIN itself was never stored, so the rule could be
    -- switched on and then honoured by nothing. It is stored here as a bcrypt hash, the same way a password is, and
    -- never as the digits: a four-digit number is trivially recoverable from any reversible form.
    ALTER TABLE settings ADD COLUMN approval_pin_hash TEXT;
    ALTER TABLE settings ADD COLUMN approval_pin_set_at TEXT;

    -- An unpaid order expires and releases its stock. Default two hours, per the brief.
    ALTER TABLE settings ADD COLUMN order_expiry_minutes INTEGER NOT NULL DEFAULT 120
      CHECK (typeof(order_expiry_minutes) = 'integer' AND order_expiry_minutes BETWEEN 1 AND 10080);
  `)
}
