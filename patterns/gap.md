# Special desync cases focused on `mt_on_withdraw` return value

> Note: function name is written as `mt_on_withdraw` here to match your wording; in codebases it is often `mt_on_withdraw`/`mt_on_transfer`.

## Goal of this document

This file is **not** about `withdraw` failing.
It focuses on cases where:

1. `mt_on_withdraw` execution path **continues**,
2. `withdraw` executes and can succeed,
3. `on_withdraw_complete` can also succeed,
4. but the value observed by the token resolver is unusual (non-zero / malformed / mis-sized), causing refund behavior.

Because your protocol intentionally ties refund to `mt_on_withdraw` return, these are the highest-value attack patterns.

---

## Threat model: where the gap appears

If `mt_on_withdraw` both:

- schedules side effects (`withdraw` chain), and
- returns a value that controls refund,

then any logic bug in **return construction** can create:

- external success on destination chain, and
- local refund on source chain.

That is the exact desync target.

---

## Creative payload-driven edge cases to try

## 1) Partial-parse fallback that still schedules withdraw

**Pattern to look for in code**

- `msg` parsing with fallback defaults, e.g. `serde_json::from_str(...).unwrap_or(default)`
- or parse into `Value` and missing fields default to `0`

**Payload idea**

- Send a `msg` that is syntactically valid JSON but semantically odd:
  - missing optional field used only in refund math,
  - present field used by withdraw path.

Example payload:
`{"receiver_id":"dest","amount":"1000","refund_hint":null}`

**Expected weird behavior**

- withdraw uses `amount=1000` and succeeds,
- refund calculation sees `refund_hint` fallback and returns non-zero vector.

---

## 2) Duplicate-key JSON ambiguity (first-wins vs last-wins)

**Pattern**

- one path parses into struct, another into map/value,
- or on-chain vs relayer parser differs.

**Payload**
`{"receiver_id":"good","receiver_id":"evil","amount":"1"}`

**What to test**

- whether return builder reads one value while withdraw builder reads another.

**Desync result**

- withdraw succeeds to one target,
- return vector built from conflicting interpretation produces refund amount.

---

## 3) Vector length mismatch created by batch shape tricks

**Pattern**

- output refund vector created from `processed_tokens.len()` instead of `token_ids.len()`,
- dedup in business logic but no dedup in resolver expectation.

**Payload**

- `token_ids=["usdc","usdc"]`, `amounts=["10","10"]`
- or `token_ids=["fee","asset"]` when code expects `[asset,fee]`

**Why valuable**

- withdraw path may normalize/dedup and still succeed,
- returned vector length/order mismatch can make resolver interpret as failure/refund.

---

## 4) Dust/rounding branch leaks non-zero unused

**Pattern**

- integer division for fees, bridge rates, decimals conversion,
- branch like `unused = input - effective_amount`.

**Payload**

- amounts near rounding boundaries:
  - `1`, `9`, `10`, `11`, `99`, `100`, `101`, etc.
- especially with mixed decimals asset pairs.

**Expected**

- withdraw succeeds for rounded-down amount,
- return vector contains 1-wei dust as refund unexpectedly.

This is a silent desync if relayer releases full logical amount while source refunds dust repeatedly at scale.

---

## 5) Zero-like numeric strings accepted differently inside code paths

**Pattern**

- one path uses strict parser, another uses permissive conversion.

**Payload set**

- `"0"`, `"00"`, `"0000"`, `"+0"`
- very large with leading zeros.

**Target**

- make one branch treat value as valid zero for withdraw precondition,
- another branch treat formatting as invalid/edge and return non-zero unused.

---

## 6) UTF-8 / normalization mismatch in token IDs or receiver IDs

**Pattern**

- map keys are compared as raw bytes in one place and normalized string in another.

**Payload**

- visually identical IDs with different normalization (NFC/NFD),
- trailing unicode whitespace.

**Outcome**

- withdraw path uses canonicalized lookup and succeeds,
- refund bookkeeping misses key and returns full or partial unused.

---

## 7) Optional field toggles “simulation mode” return logic

**Pattern**

- flags like `dry_run`, `estimate`, `quote_only` in msg,
- intended for integration/testing.

**Payload**
`{"receiver_id":"dest","amount":"1000","quote_only":true}`

**Potential bug**

- flag affects only return calculation branch,
- but withdraw scheduling ignores flag and still executes.

---

## 8) Callback data races on mutable temp state used for return

**Pattern**

- `mt_on_withdraw` reads/writes temporary state shared across calls (e.g. cached quote, rolling nonce bucket),
- return vector depends on that mutable state.

**Payload strategy**

- submit two crafted transfers in adjacent blocks:
  - tx A sets cache with edge value,
  - tx B consumes it and gets unusual refund vector while still scheduling valid withdraw.

---

## 9) Saturating math / checked math fallback only in return path

**Pattern**

- withdraw uses checked validated amount,
- return uses `saturating_sub` or fallback-on-overflow.

**Payload**

- max-ish values near `u128` boundaries in msg fields not directly used by withdraw amount but used in return diff.

**Result**

- withdraw executes with bounded amount,
- return math saturates to huge/incorrect unused vector.

---

## 10) Promise detachment + non-deterministic return branch

**Pattern**

- function detaches withdraw promise,
- return value depends on post-validation branch with external-state read (e.g., config map / per-user toggle).

**Payload strategy**

- pick account/config combination that enters unusual return branch (`[full_amount]`, wrong length, wrong token index),
- keep withdraw params otherwise valid.

**Impact**

- resolver refunds from return vector, while detached withdraw still succeeds.

---

## 11) Mixed success in multi-asset batch where policy expects all-or-nothing

**Pattern**

- withdraw is called once per asset and best-effort continues,
- return vector treats any sub-failure as refundable for entire batch.

**Payload**

- asset A fully valid,
- asset B crafted to hit edge validation that does not abort function (just marks unused).

**Outcome**

- asset A withdraw succeeds and can trigger destination release,
- return includes refund for B (or whole batch due policy bug).

---

## 12) Return serialization mismatch while business logic succeeds

**Pattern**

- return built as native numbers instead of string-U128 in one branch,
- or accidental `Vec<u64>` / nested vec in rare path.

**Payload trigger**

- branch-specific conditions such as `if memo.is_some()` or special token id.

**Outcome**

- withdraw and callback succeed,
- resolver cannot parse returned schema and applies refund behavior.

---

## High-value test matrix (practical)

For each payload class above, run this invariant check:

- `withdraw_succeeded == true`
- `on_withdraw_complete_succeeded == true`
- `resolver_observed_return != expected_zero_vector`

Then flag if any of:

- refund > 0,
- refund vector length mismatch,
- parse failure interpreted as refund.

Prioritize fuzzing around:

- duplicate token IDs,
- ordering permutations,
- numeric boundary strings,
- nullable/optional fields,
- unicode-normalized identifiers.

---

## Hardening specifically for your protocol choice

Since refund is intentionally based on `mt_on_withdraw` return (not withdraw result), enforce:

1. **Single canonical return builder** used by all branches.
2. **Strict schema parse** (`deny_unknown_fields`, no fallback defaults for refund-critical fields).
3. **Return-shape assertion before return**: exact length/order/type every time.
4. **No branch-dependent serialization**; always produce `Vec<U128>` canonical form.
5. **Property tests**: any path that schedules withdraw must return zero vector unless explicit business rule says otherwise.

If you want, I can also add a second section with concrete near-workspaces test case templates for each payload class.
