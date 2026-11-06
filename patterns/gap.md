# Sharp desync playbook (logic-first, based on measured campaigns)

This is a logic-level threat model, not a code-style bug list.

## What your measurements prove

### A) Amount split is deterministic and controllable

With `MT_AMOUNTS=["2000"]`:

- `amount_native="0"` -> bridge `2000`, receiver `0`
- `amount_native="1"` -> bridge `1999`, receiver `1`
- `amount_native="1999"` -> bridge `1`, receiver `1999`
- `amount_native="2000"` -> bridge `0`, receiver `2000`
- `amount_native="2001"` -> panic (overflow)

**Meaning:** `amount_native` is effectively a routing dial between bridge vs local receiver.

### B) Return semantics are already suspicious

You observed: `mt_on_transfer` returns `0`, but resolver returns original `2000` (even in failed transactions).

**Meaning:** settlement/refund interpretation is likely decoupled from the business result. This is the core risk.

### C) Gas has a settlement cliff, not just execution failure

At high `MT_MIN_GAS`, you get `published but not settled / NOT_FOUND_OR_NOT_VALID`.

**Meaning:** there is a split-brain window between “intent publication” and “final accounting truth”.

### D) Receiver length has boundary behavior (704/880 observations)

Crossing length boundaries changes outcome mode.

**Meaning:** input size can be used as a deterministic phase-switch to push flow into different settlement paths.

### E) Duplicate critical JSON fields are rejected

`receiver_id`, `amount_native`, `block_number` duplicates panic.

**Meaning:** that vector is closed; do not spend effort there.

---

## Redefined campaigns (rare, sharp, logic-driven)

## Campaign 1 — **Economic desync without technical failure**

Use the routing dial intentionally:

- Keep transaction “valid”.
- Move most value to receiver via `amount_native` close to full amount.
- Keep resolver behavior pinned to original amount signal (as you observed).

### Why this is rare and dangerous

This is not a parser bug; it is a semantic mismatch between:

1. what _moved where_, and
2. what _resolver believes should be refunded/settled_.

If resolver still anchors to original `MT_AMOUNTS`, attacker can arbitrage bridge/receiver allocation while accounting lags or misattributes.

---

## Campaign 2 — **Published-success / settlement-fail arbitrage**

Target the zone where intent is published, side effects may occur, but settlement is `NOT_FOUND_OR_NOT_VALID`.

### Attack shape

1. Force high-but-accepted complexity (gas near cliff, long receiver near boundary).
2. Obtain intermediate success evidence (intent published / receipts / offchain watcher trigger).
3. Let final settle fail or become ambiguous.

### Exploit condition

If any relayer/ops process acts on publication or intermediate receipts, you can get external completion while internal accounting remains refundable/retryable.

---

## Campaign 3 — **Boundary steering via receiver length**

You found hard behavioral edges (704, 880).
Treat input length as a control surface, not fuzz noise.

### Objective

Find two adjacent lengths where:

- both pass initial simulation,
- one finalizes clean,
- one drifts into non-settled or alternate resolver behavior.

### Why this matters

This gives an attacker a reproducible “mode switch” to choose accounting branch outcomes while keeping payload semantics same.

---

## Campaign 4 — **Resolver truth-source inversion**

Your strongest anomaly: callback/transfer says zero-style success, resolver reports original amount.

### Hypothesis to validate

Resolver may treat absent/failed parse/failed callback as “refund original,” independent of partial economic execution.

### Practical test

For each `amount_native` in `{0,1,1999,2000}` record:

- actual bridged amount,
- actual receiver amount,
- resolver returned amount.

If resolver stays constant while economics vary, the protocol has a truth-source inversion vulnerability.

---

## Campaign 5 — **Cross-stage semantic drift (simulation vs execution)**

You already know simulation and execution are separate.
The rare bug is not “invalid accepted”; it is “valid interpreted differently across stages.”

### Focus inputs

- same semantic payload, different size/ordering/unknown-key density,
- near gas thresholds,
- near receiver-length thresholds.

### Red flag

Simulation predicts one economic split; execution settles another, while resolver sticks to a third value source.

---

## Campaign 6 — **First-token privilege + invisible liabilities**

Since only index 0 is bridged, the model is asymmetric by design.

### Logic risk

If settlement/refund logic is vectorized by full input but economic bridge logic is scalar (index 0 only), liabilities can appear on non-bridged paths.

### Rare scenario

Construct multi-token batches where non-first tokens are value-heavy. Even if no immediate bug appears, inspect whether accounting emits latent refundable claims not backed by bridge behavior.

---

## Campaign 7 — **Intent replay semantics through unconstrained `block_number` meaning**

Even if any `block_number` is accepted, the logic question is: does it influence idempotency, nonce scope, or settlement identity?

### Attack idea

Repeat economically equivalent intents with varied `block_number` and near-identical payloads.

### Goal

Find whether system treats them as distinct in one stage and equivalent in another (or vice versa), creating double-process or double-refund windows.

---

## Campaign 8 — **Overflow edge as oracle, not exploit**

`amount_native=2001` panics for amount 2000. Use this edge as a precision oracle.

### Method

Probe near edge (`1998,1999,2000,2001`) under varying gas/receiver-length conditions.

### Why useful

You can map exact ordering of checks and discover where side effects happen relative to overflow guard. That reveals whether “some effects before final reject” is possible in specific paths.

---

## Priority test matrix (small but high signal)

Run this grid first:

- `amount_native`: `0,1,1999,2000`
- `receiver_len`: `680,700,704,705,760,880`
- `min_gas`: `low-pass`, `near-cliff`, `just-over-cliff`

For each case, capture only these truths:

1. **Economic outcome**: `(bridged, sent_to_receiver)`
2. **Protocol outcome**: `(published?, settled?, status)`
3. **Resolver outcome**: `(returned amount/vector)`

### Critical finding definition

A case is critical when all hold:

- economic outcome differs from baseline,
- resolver outcome stays fixed to baseline/original amount,
- and settle path is ambiguous or inconsistent (`NOT_FOUND_OR_NOT_VALID`, retryable, or delayed).

That combination is the real desync surface.

---

## What to stop testing (low value now)

Based on your results:

- duplicate critical keys (`receiver_id`, `amount_native`, `block_number`) -> already hard-fail,
- random extra keys causing no behavior change -> low priority unless combined with boundary conditions.

Focus energy on **semantic splits + settlement ambiguity**, not parser trivia.

---

## Strategic hardening goals (logic layer)

1. Define one canonical settlement truth: economic movement must match resolver-return basis.
2. Make publication non-authoritative: only final settle can trigger external release/accounting.
3. Bind `amount_native` semantics explicitly to accounting invariants (not just execution routing).
4. Treat boundary-triggered mode changes (gas, receiver length) as security-critical and eliminate branch-dependent accounting.
5. Add invariants at protocol level: no state where `(bridge_or_receiver moved value)` AND `(resolver implies full refundable original)` simultaneously.

This is the sharpest reading of your data: the vulnerability is likely **logic desynchronization across truth sources**, not classic input-validation bugs.
