# Gap-focused attack patterns (env-specific, desync-first)

This revision uses your concrete config and your observations.

## Baseline under test

- `MT_CONTRACT = v2_1.omni.hot.tg`
- `MT_RECEIVER_ID = bridge-refuel.hot.tg`
- `MT_TOKEN_IDS = ["137_qiStmoQJDQPTebaPjgx5VBxZv6L"]`
- `MT_AMOUNTS = ["2000"]`
- `MT_CALLBACK_MSG_JSON = {"amount_native":"0","receiver_id":"2aEi7QMoRCvshYvrT779cXaDk1ha","block_number":100}`
- `MT_MIN_GAS = 1000`

Critical behavior from your notes:

- only index `0` token is truly bridged; extra tokens are transferred directly to receiver,
- unknown keys accepted,
- duplicate unknown keys last-wins,
- `amount_native=0` can still succeed,
- any `block_number` seems accepted,
- huge `receiver_id` can consume all gas,
- there are “published but not settled” outcomes.

Your target class (correct):

> `mt_on_withdrwal` returns unusual value (or parse shape), while withdraw path still succeeds and `on_withdraw_complete` can still report success.

---

## Red-team campaigns (non-generic, tuned to your setup)

## Campaign 1: Dual-source amount divergence (`MT_AMOUNTS` vs `msg.amount_native`)

Your baseline already sets `MT_AMOUNTS[0] = 2000` and `amount_native = "0"`.

That is a perfect wedge: if bridge amount comes from transfer array but refund logic reads `amount_native`, you can get silent non-zero unused.

### Payload ladder

1. `{"amount_native":"0","receiver_id":"2aEi7...","block_number":100}`
2. `{"amount_native":"1","receiver_id":"2aEi7...","block_number":100}`
3. `{"amount_native":"1999","receiver_id":"2aEi7...","block_number":100}`
4. `{"amount_native":"2000","receiver_id":"2aEi7...","block_number":100}`
5. `{"amount_native":"2001","receiver_id":"2aEi7...","block_number":100}`

Keep `MT_AMOUNTS=["2000"]` constant for all runs.

### What you are hunting

- withdraw receipt succeeds in all/most cases,
- resolver return vector changes with `amount_native`, not with transferred amount.

If true, refund logic can be steered independently of bridged amount.

---

## Campaign 2: Gas-unit confusion exploit (`MT_MIN_GAS=1000`)

`1000` is suspiciously tiny if interpreted as yocto-gas-like raw units, but maybe middleware rescales it.

Try to detect inconsistent unit conversions between simulation and execution.

### Sweep set (exact values)

`[0, 1, 999, 1000, 1001, 10_000, 1_000_000, 10^9, 10^12, 10^14]`

### Why this is clever

If one stage treats this as “TGas-like” and another as raw gas, you can get:

- simulation pass,
- execution with partial receipt completion,
- weird final return interpretation / settle behavior.

Correlate each gas value with:

- withdraw status,
- callback status,
- resolver refund vector.

---

## Campaign 3: Receiver length cliff where side-effect survives

You already observed giant `receiver_id` can panic with prepaid gas exhausted.

Do a binary search on receiver length to find this exact zone:

- enough gas for withdraw + callback to be emitted/executed,
- but return construction / tail parsing / event serialization becomes unstable.

### Concrete strategy

Use base58-safe receiver strings of lengths:

`[44, 88, 176, 352, 704, 1408, 2816]`

Then binary search around first failing threshold.

### High-value signal

`withdraw success == true` while resolver sees malformed/failed return branch -> refund.

---

## Campaign 4: Duplicate-key conflict on critical fields

You confirmed duplicate unknown keys are last-wins; now test if critical keys behave consistently across stages.

### Payloads

1. `{"amount_native":"2000","amount_native":"0","receiver_id":"2aEi7...","block_number":100}`
2. `{"receiver_id":"good","receiver_id":"2aEi7...","amount_native":"2000","block_number":100}`
3. `{"block_number":100,"block_number":0,"amount_native":"2000","receiver_id":"2aEi7..."}`

### Desync angle

If simulation and execution don’t preserve the same key-overwrite semantics after reserialization, they may disagree silently.

---

## Campaign 5: Unknown-key shadowing of internal names

Unknown keys are accepted; inject names likely to collide with internal struct/map logic.

### Payload examples

- `"amount":"2000"`
- `"native_amount":"2000"`
- `"refund":"2000"`
- `"token_id":"137_qiSt..."`
- `"min_gas":"100000000000000"`
- `"receiver":"2aEi7..."`

Use them together with valid required fields.

### Why this matters

If any branch parses generic `serde_json::Value` and checks `get("amount")` or similar fallbacks, return logic can be influenced without breaking withdraw path.

---

## Campaign 6: Multi-token parasitic refund (first token bridge, others direct)

Exploit your protocol asymmetry directly.

### Payload profile

- `token_ids = [A, B, C]`
- `amounts = [2000, 1, 1]` then `[2000, 999999, 999999]`
- msg remains valid for A bridging.

### Hunt

- A bridge succeeds,
- B/C are directly delivered to receiver,
- return vector accidentally credits refundable unused for B/C due index mismatch.

This is high-impact because extra indices are most likely to be mis-accounted.

---

## Campaign 7: Duplicate token-id role confusion

Test position-sensitive logic with same token repeated.

### Payload set

- `[A, A]` with `[2000, 1]`
- `[A, A, A]` with `[2000, 1, 999999]`

### Attack thesis

If bookkeeping maps by token id but return vector is by index, one slot can be treated as unprocessed/refundable while value moved already.

---

## Campaign 8: `block_number` steering for branch drift

Since any block number appears accepted, drive corner branches.

### Payload values

`block_number = 0, 1, 100, current+1, 2^63-1, 2^64-1`

### What to detect

- same withdraw behavior,
- different return behavior (or different settle route / relayer decision).

If `block_number` is incorporated into idempotency keys inconsistently, this can create replay-like side effects with altered refund outcomes.

---

## Campaign 9: Near-maximum numeric strings that do not panic

You’ve already found panic points. Now aim right below them.

### Payload corpus for `amount_native`

- `"340282366920938463463374607431768211454"` (u128 max-1)
- same value with leading zeros
- `"18446744073709551615"` (u64 max)
- `"18446744073709551616"` (u64 max+1)

### Goal

No immediate panic, but subtle cast/branch asymmetry in return math.

---

## Campaign 10: Nested-JSON ambiguity (you noted nested `amount_native` success)

This is very non-generic and very valuable in your case.

### Payload variants

1. `{"amount_native":{"v":"2000"},"receiver_id":"2aEi7...","block_number":100}`
2. `{"amount_native":{"amount":"2000"},"receiver_id":"2aEi7...","block_number":100}`
3. `{"amount_native":["2000"],"receiver_id":"2aEi7...","block_number":100}`

### Why this is critical

If one stage stringifies nested data and another strictly parses, you can get cross-stage disagreement without obvious execution failure.

---

## Campaign 11: Settlement race (“published not settled”)

You observed `Intent is published but not settled`.

### Exploit model

1. craft payload that emits intermediate success signal (event/log/receipt),
2. stress final settle path (gas boundary, long receiver, heavy payload),
3. watch whether relayer acts on intermediate signal.

### Success condition

External release occurs, but resolver path later records refundable or unresolved status.

---

## Campaign 12: Callback-visible-field insufficiency

You observed callback sees limited subset in multi-token scenarios.

### Attack setup

Use 3+ token arrays where semantic validity depends on token #3, but callback can only infer from token #1/#2 subset.

### Failure mode

Callback returns structurally valid but semantically wrong refund vector because it cannot reconstruct full intent context.

---

## Minimal “elite” payload pack (start here)

Use these first before broad fuzzing:

1. **Amount split baseline**  
   `{"amount_native":"0","receiver_id":"2aEi7QMoRCvshYvrT779cXaDk1ha","block_number":100}` with `amounts=["2000"]`
2. **Duplicate critical key**  
   `{"amount_native":"2000","amount_native":"0","receiver_id":"2aEi7QMoRCvshYvrT779cXaDk1ha","block_number":100}`
3. **Nested amount_native**  
   `{"amount_native":{"v":"2000"},"receiver_id":"2aEi7QMoRCvshYvrT779cXaDk1ha","block_number":100}`
4. **Long receiver cliff**  
   valid base58 receiver at 700+ chars with normal `amount_native`.
5. **Multi-token asymmetry**  
   `token_ids=[A,B,C]`, `amounts=[2000,1,1]`, normal msg for A.

If any of these gives `(withdraw=success) AND (refund>0 or abnormal return shape)`, treat as critical.

---

## Strict invariants to enforce in your tests

For each run capture:

1. simulation result,
2. execution result,
3. withdraw receipt result,
4. `on_withdraw_complete` result,
5. resolver-observed return bytes/value,
6. per-index refunded amounts.

Critical finding rule:

- withdraw succeeded,
- callback succeeded (or relayer acted as success),
- return value produced non-zero refund / parse fallback / length mismatch.

---

## Hardening (specific to your architecture)

1. Make `amount_native` and `amounts[0]` consistency mandatory (or remove one source of truth).
2. Reject unknown keys and duplicate keys outright.
3. Reject nested/non-string `amount_native` at schema boundary.
4. Add explicit max length for `receiver_id` before any promise scheduling.
5. Make `block_number` bounded and semantically checked.
6. For multi-token calls, lock refund semantics to deterministic zero for non-bridged indices unless intentionally supported.
7. Before returning from `mt_on_withdrwal`, assert exact vector length and exact canonical type.
8. Relayer must only release on final settle success, never on intermediate logs.

This checklist is built for your exact env and observed behavior, not generic bridge advice.
