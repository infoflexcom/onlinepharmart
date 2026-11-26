import type Database from 'better-sqlite3'

/**
 * The daily audit: what migration 16 designed for a Supervisor and this phase fills in.
 *
 * Migration 16 created `audit_signoffs` and `audit_flags` and called them "the audit-only supervisor's surface", then
 * built nothing on them — no service ever wrote a row to either. This phase is the building. It needs four things the
 * earlier design did not have, and it deliberately adds **no** table for audited days:
 *
 * - **`audit_signoffs.outcome`.** The brief gives the Supervisor exactly two verdicts — "Audited" and "Audited with
 *   issues" — and a sign-off row as designed had nowhere to put the difference. Encoding the verdict inside the free
 *   `note` text would mean reading a person's prose to answer "is this day clean?", so it is a checked column.
 * - **`audit_signoffs.scope_account_id`.** A day is audited for one Account at a time ("pick a date and an Account"),
 *   so the subject of a `DAY_CLOSE` sign-off is a date *and* a till user. `subject_id` stays the business date — a
 *   date is what the Admin's dashboard lists — and the account rides beside it. Nullable because the other subject
 *   kinds (RETURN, ORDER, …) are not per-account.
 * - **`audit_flags.source` and `audit_flags.check_code`.** A flag is either something a person wrote or something a
 *   check found. Telling them apart matters because only the automatic ones can be recomputed, and `check_code` is
 *   what stops the same check writing the same finding twice.
 * - **`debtor_payments`.** The brief requires the audit to show "credit sales and debtor payments", and the capability
 *   `record_debtor_payment` has been granted to ACCOUNT since the capability table was written — but no table could
 *   hold such a payment. `payments` cannot: its CHECK forces every row to reference either a sale or a return, and a
 *   customer settling an old balance is neither. A report section that could only ever be empty would be a lie of
 *   omission on the one screen whose whole job is finding things out, so the storage is added here.
 *
 * **Not added: a table of audited days.** Whether a day is audited is the existence of a sign-off row for it, and
 * whether a day *needs* auditing is the existence of sales on it. Both are one query over tables that already exist.
 * Storing "audited days" separately would be a second list that can disagree with the sign-offs — the same mistake
 * migration 18 deleted when it found `sales.order_id` had been there all along.
 *
 * **Not added: stored totals on the sign-off.** The brief requires audit totals to reconcile with the sales ledger to
 * the last unit. Totals that are written down at sign-off time and read back later are totals that can drift from the
 * ledger; totals that are always recomputed from `sales`, `payments`, `returns` and `day_closings` cannot. The only
 * thing recorded about the numbers is `subject_digest`, which migration 16 designed for exactly this: a hash of what
 * the signer was shown, so a later change to the subject is *detectable* without keeping a shadow copy of it.
 */
export function migrateDailyAudit(database: Database.Database): void {
  database.exec(`
    -- ── audit_signoffs: the verdict, and whose day it was ─────────────────────────────────────────────
    ALTER TABLE audit_signoffs ADD COLUMN outcome TEXT NOT NULL DEFAULT 'AUDITED'
      CHECK (outcome IN ('AUDITED', 'AUDITED_WITH_ISSUES'));

    -- A REFERENCES column added by ALTER must default to NULL, which is also the right meaning here: every subject
    -- kind other than DAY_CLOSE is not scoped to one Account.
    ALTER TABLE audit_signoffs ADD COLUMN scope_account_id TEXT REFERENCES users(id);

    -- One verdict per day per Account. A sign-off is an attestation and history is not edited, so a second attempt to
    -- sign the same day is refused by the service and, if anything ever bypasses the service, by this index.
    --
    -- The COALESCE is not decoration. A column added by ALTER TABLE with a REFERENCES clause must default to NULL, and
    -- in a SQLite unique index two NULLs are distinct — so without it the whole-store sign-off, which is the one with no
    -- Account against it, could be written twice and the index would say nothing. Coalescing to an empty string makes
    -- "the whole store" a value that can collide, which is the only way the guarantee is a real one.
    CREATE UNIQUE INDEX idx_audit_signoffs_one_per_day
      ON audit_signoffs(subject_kind, subject_id, COALESCE(scope_account_id, ''))
      WHERE subject_kind = 'DAY_CLOSE';

    -- ── audit_flags: who found it, and which check found it ───────────────────────────────────────────
    ALTER TABLE audit_flags ADD COLUMN source TEXT NOT NULL DEFAULT 'MANUAL'
      CHECK (source IN ('MANUAL', 'AUTOMATIC'));

    -- Empty for a manual flag. For an automatic one it is the check's code, from the single list the checks and the
    -- tests both read, so a renamed check cannot leave orphaned notes behind.
    ALTER TABLE audit_flags ADD COLUMN check_code TEXT NOT NULL DEFAULT '';

    -- The day the flag belongs to. Deriving it back out of subject_id would mean every reader agreeing on a format;
    -- storing it means the Admin's dashboard and the phone summary can ask "which days have open flags" in one query.
    ALTER TABLE audit_flags ADD COLUMN business_date TEXT NOT NULL DEFAULT '';

    -- Whose till the flag is about, when it is about one. Nullable for the same reason as on the sign-off: a flag on a
    -- return or an order belongs to a document, not to an Account.
    ALTER TABLE audit_flags ADD COLUMN scope_account_id TEXT REFERENCES users(id);

    -- One open note per automatic check per subject per till. A check is recomputed every time the day is opened, and
    -- opening a day nine times must not leave nine copies of the same finding.
    -- COALESCE for the reason given above: a note on a whole-store day has no Account against it, and NULL would let
    -- the same check write the same finding twice.
    CREATE UNIQUE INDEX idx_audit_flags_one_open_per_check
      ON audit_flags(subject_kind, subject_id, COALESCE(scope_account_id, ''), check_code)
      WHERE source = 'AUTOMATIC' AND resolved_at IS NULL;

    CREATE INDEX idx_audit_flags_day ON audit_flags(business_date, resolved_at);

    -- ── debtor_payments: a customer settling what they owe ────────────────────────────────────────────
    -- Numbered from document_sequences like orders and server receipts, not from MAX(id) over its own table: one
    -- allocator, protected by the trigger that refuses a number moving backwards.
    CREATE TABLE debtor_payments (
      id TEXT PRIMARY KEY,
      payment_number TEXT NOT NULL UNIQUE,
      customer_id TEXT NOT NULL REFERENCES customers(id),
      received_by TEXT NOT NULL REFERENCES users(id),
      -- No CASH-only rule and no CREDIT: this is money arriving, so the methods are the ones a drawer can actually
      -- take. CASH is the only one that changes the expected cash in the drawer, and the day close counts that.
      payment_method TEXT NOT NULL CHECK (payment_method IN ('CASH', 'TRANSFER', 'CARD')),
      amount INTEGER NOT NULL CHECK (typeof(amount) = 'integer' AND amount > 0),
      currency_code TEXT NOT NULL REFERENCES currencies(code),
      -- What the balance was before and after, so a payment that does not agree with the movement it caused is
      -- visible on the audit screen without recomputing anybody's history.
      balance_before INTEGER NOT NULL CHECK (typeof(balance_before) = 'integer'),
      balance_after INTEGER NOT NULL CHECK (typeof(balance_after) = 'integer'),
      reference TEXT NOT NULL DEFAULT '',
      note TEXT NOT NULL DEFAULT '',
      business_date TEXT NOT NULL,
      -- The open shift the money went into, when the till had one. A supermarket counts the day per shift, and cash
      -- taken for an old debt is in that drawer exactly like cash taken for a sale: without this column the shift's
      -- expected cash would be short by every debt collected during it.
      shift_id TEXT REFERENCES cashier_shifts(id),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX idx_debtor_payments_customer ON debtor_payments(customer_id, created_at DESC);
    CREATE INDEX idx_debtor_payments_day ON debtor_payments(business_date, currency_code);
    CREATE INDEX idx_debtor_payments_shift ON debtor_payments(shift_id);

    INSERT INTO document_sequences (kind, last_value)
      SELECT 'DEBTOR_PAYMENT', 0
      WHERE NOT EXISTS (SELECT 1 FROM document_sequences WHERE kind = 'DEBTOR_PAYMENT');

    -- A received payment is money history: it can be read forever and it cannot be edited into something else. The
    -- balance it moved is the record of what it did, and a corrected payment is a new row, not a changed one.
    CREATE TRIGGER debtor_payments_cannot_be_changed
    BEFORE UPDATE ON debtor_payments
    BEGIN
      SELECT RAISE(ABORT, 'Received debtor payments cannot be changed');
    END;

    CREATE TRIGGER debtor_payments_cannot_be_deleted
    BEFORE DELETE ON debtor_payments
    BEGIN
      SELECT RAISE(ABORT, 'Received debtor payments cannot be deleted');
    END;
  `)
}
