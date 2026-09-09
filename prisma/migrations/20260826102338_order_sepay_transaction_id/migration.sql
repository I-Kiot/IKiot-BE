-- SePay's own transaction id, restored from iKiotMS-BE where both models carried it.
--
-- It is the only key linking an order (and its money row) to a line on the bank statement;
-- the first port dropped it, so a confirmed transfer left nothing behind but a log line.
-- TEXT rather than the old model's Number: the webhook payload is untyped JSON and an id
-- is an identifier, not a quantity - same choice already made for
-- subscription_invoices.transaction_ref.
--
-- Nullable and unconstrained on purpose: only SEPAY orders ever have one, and rows written
-- before this migration never will.

-- AlterTable
ALTER TABLE "cash_flows" ADD COLUMN     "sepay_transaction_id" TEXT;

-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "sepay_transaction_id" TEXT;
