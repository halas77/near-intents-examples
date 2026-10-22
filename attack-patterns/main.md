**Core idea**
If you cannot force malformed callback data directly, you look for real flows that could naturally produce shape mismatch, then prove whether accounting breaks.

1. Observe callback evidence from chain receipts.
2. Observe economic state changes before/after.
3. Use adversarial request patterns that might trigger adapter normalization, filtering, or dedup behavior upstream.

Your current scripts already support this:
`withdraw-tokens.ts`
`get-balances.ts`
`package.json`

**What to measure (oracles)**

1. Receipt-shape oracle:

- Decode NEAR receipt SuccessValue for the external transfer call in the withdraw tx.
- Check whether returned array length equals requested withdrawal count.

2. Economic oracle:

- Pre-balance internal (intents) for each asset.
- Post-balance internal for each asset.
- Confirm destination transfer evidence exists (tx hash or explorer balance change).
- If destination moved funds and internal got fully refunded, that is the double-credit signal.

3. Metamorphic oracle:

- Same logical withdrawal expressed in different request shapes should preserve accounting.
- Any divergence suggests resolver/adapter shape handling risk.

**Creative request patterns to try**
Use tiny canary amounts first.

1. Duplicate-asset collapse probe

- Two entries, same token and same destination, different amounts.
- Hypothesis: upstream dedups/aggregates and returns one result element.

2. Split-vs-merge equivalence probe

- Run A: one entry amount X.
- Run B: two entries of same token/destination summing to X.
- Expect same total debit/credit behavior. If not, suspect shape mismatch handling.

3. Order-permutation probe

- Run A: [token1, token2].
- Run B: [token2, token1].
- Expect order-independent economics.

4. Mixed-validity probe

- One entry clearly valid.
- One entry likely to be rejected by destination formatting rules (for chain/memo requirements).
- Hypothesis: only successful leg appears in callback array.

5. Dust-filter probe

- One amount near minimum practical bridge amount.
- One normal amount.
- Hypothesis: dust leg silently dropped by upstream and callback length shrinks.

**How to run with this repo**

1. Snapshot internal balances using pnpm sdk/get-balances.
2. Configure a 2-entry withdraw case in `withdraw-tokens.ts`.
3. Execute pnpm sdk/withdraw-tokens.
4. Save intent hash and destination tx hashes printed by the script.
5. Query NEAR tx receipts for that hash and decode callback SuccessValue.
6. Snapshot internal balances again.
7. Compare:

- Requested count vs callback array count.
- Internal debit/refund vs destination transfer evidence.

**Important limitation**
Without control over the resolver/bridge, you cannot guarantee triggering malformed shape on demand. But this method still gives high-confidence detection if it ever happens in production behavior.

**What would count as confirmed issue**

1. Callback parsed successfully but returned wrong-length vector.
2. Resolver treated mismatch as all-zero-used (full refund semantics).
3. Destination transfer still happened for at least one leg.
4. Internal balance credit does not reconcile with external movement.

5. I can draft a ready-to-run black-box test matrix (10 exact cases with expected outcomes and pass/fail checks).
6. I can also draft a receipt-decoding checklist for EXPERIMENTAL_tx_status so you can consistently extract callback payload shape across runs.

Created 3 todos
