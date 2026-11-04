# Can `mt_on_transfer` succeed but hand back something other than `[0, 0]`?

## Short answer

Yes, but only in a few specific ways. Within a single receipt, NEAR is atomic. If `mt_on_transfer` panics or runs out of gas, its state changes are rolled back and none of the promises it created are sent. A `withdraw` promise created inside a `mt_on_transfer` that fails never runs. That part of your assumption holds.

The desync comes from what `mt_resolve_transfer` actually reads as "the return value." It is not always the value your function's code returns:

| What `mt_on_transfer` returns                                      | What `mt_resolve_transfer` sees                                                                               |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| `PromiseOrValue::Value(vec![0,0])`                                 | `[0,0]`                                                                                                       |
| Panics or runs out of gas                                          | `PromiseResult::Failed` → full refund, and `withdraw` never runs ✅                                           |
| `PromiseOrValue::Promise(withdraw().then(on_withdraw_complete()))` | **The result of the last promise in the chain**, i.e. whatever `on_withdraw_complete` returns or how it fails |

The third row is the main risk. If you return the promise chain, your statement "withdraw pass/fail doesn't determine the return value" is only true if `on_withdraw_complete` can never fail and always returns a well-formed `["0","0"]`. If it fails after `withdraw` succeeded, the token contract sees `Failed` and refunds everything. The user then gets paid on the other chain and also refunded on NEAR, which is a double spend.

## Edge cases that can cause the desync

### 1. Out-of-gas in the tail callback, possibly triggered on purpose

`withdraw` succeeds, then `on_withdraw_complete` runs out of gas, so the token contract refunds everything.

- The whole chain (`execute_intents` → ... → `mt_resolve_withdraw`) shares a 300 Tgas budget per transaction, so gas is tight.
- If the gas attached to the intent is controlled by the user (for example a `min_gas`-style field on the withdraw intent), an attacker can binary-search a value where `mt_on_transfer` and `withdraw` succeed but the callback runs out of gas.
- Unused-gas splitting by weight (`gas_weight`) makes the leftover gas hard to predict.

### 2. The callback returns the wrong type or shape

These all turn into "parse failed" or "length mismatch," which most NEP-245 resolvers treat as a full refund:

- `on_withdraw_complete` returns `()`, `bool`, a bare `U128`, or `vec![0]` for a two-token batch.
- It returns JSON numbers `[0,0]` instead of strings `["0","0"]`. `near_sdk::json_types::U128` expects strings.
- The chain ends at `withdraw` (you forgot `.then`), so the resolver parses `withdraw`'s return value as `Vec<U128>`.
- Code paths like `if x { return vec![amount, 0] }` that return a non-zero refund even though the withdraw happened.

### 3. A panic inside `on_withdraw_complete` logic

`unwrap()`, `require!`, an overflow with `overflow-checks = true`, a failed state read after a migration, or a storage-staking failure in the callback. Each one becomes `Failed`, and that becomes a full refund.

### 4. Contract upgrade while receipts are in flight

A receipt chain spans several blocks. If the bridge or token contract is upgraded between `withdraw` and `on_withdraw_complete`, the new code may have a different signature, return type, or state layout. The callback fails or returns a different shape, and a refund follows.

### 5. The refund cap uses a shared balance

Resolvers usually refund `min(unused, receiver_balance)`. That cap is a safety net, but the bridge's balance holds every user's pooled funds. Between `mt_on_transfer` and `mt_resolve_transfer`, other users' deposits can land in the bridge. So the "already burned" protection fails, and the refund is paid out of other users' money.

### 6. The resolver itself fails, at each hop

- If `mt_resolve_transfer` runs out of gas, `mt_resolve_withdraw` on intents sees `Failed`. How does intents read that? If it treats it as "refund the user," you have a second double-refund path one hop up.
- Check every resolve step separately. A failed callback at hop N must not be read as "nothing happened" when hop N-1 already had side effects.

### 7. `mt_on_transfer` called directly, with no real transfer

If the bridge doesn't check `env::predecessor_account_id() == MT_TOKEN_CONTRACT`, anyone can call it with made-up `token_ids`, `amounts`, and `sender_id`. That triggers `withdraw` against the bridge's pooled balance. Also check that `sender_id` and `previous_owner_ids` are values you expect.

### 8. Batch argument tricks

- Duplicate ids: `token_ids: ["a","a"]`. Does the token contract reject this? Does the bridge count it twice?
- Swapped order: if the bridge assumes index 0 is the asset and index 1 is the fee, an attacker can flip them.
- Zero amounts, mismatched array lengths, or a single token when the bridge expects two (or the reverse).

### 9. Parser differences in `msg`

The bridge on NEAR and your off-chain relayer may parse `msg` differently:

- Duplicate keys, e.g. `{"receiver_id":"A", ..., "receiver_id":"B"}`. Derived serde structs reject these, but `serde_json::Value`, maps, or a JS/Go relayer may take the first or last one.
- `u128::from_str` accepts `"+0"` and leading zeros like `"000"`. Another language may not.
- Unicode or whitespace in `receiver_id`, or an address that is valid base58 but invalid on the destination chain. That doesn't cause a NEAR desync, but the funds are lost on the other side.
- `block_number` is user-supplied. Is it used for replay protection or deadlines? Can old values be replayed?

### 10. The relayer reads logs instead of the final outcome

If the off-chain side starts the cross-chain release on a `withdraw` event or log:

- Logs show up in the execution outcomes of receipts. Make sure the indexer checks each receipt's status, and especially the final resolve result, not just the presence of an `EVENT_JSON`.
- An attacker can make `withdraw` succeed (the event is emitted) while the tail fails (refund on NEAR). The relayer releases on the destination chain and NEAR refunds as well.

### 11. Detached promise ordering

If you detach `withdraw` and return `Value([0,0])`, `mt_resolve_transfer` and `withdraw` run in parallel, with no ordering guarantee. That's fine with `[0,0]`. But if any code path ever returns a non-zero refund, the refund may move tokens out before `withdraw` burns them. `withdraw` then burns pooled funds or fails.

## Hardening recommendations

1. **Separate the refund decision from the withdraw outcome.** Return a fixed value and detach the withdraw chain:

   ```rust bridge/src/lib.rs
   fn mt_on_transfer(&mut self, sender_id, previous_owner_ids, token_ids, amounts, msg) -> PromiseOrValue<Vec<U128>> {
       require!(env::predecessor_account_id() == self.mt_token, "bad caller");
       require!(sender_id == self.intents, "bad sender");
       require!(token_ids.len() == amounts.len() && token_ids.len() == EXPECTED_LEN, "bad batch");
       require!(env::prepaid_gas() >= MIN_TOTAL_GAS, "insufficient gas"); // fail early, before scheduling
       let msg: Msg = serde_json::from_str(&msg).unwrap_or_else(|_| env::panic_str("bad msg"));
       // ... validate everything, update state ...

       // detached: NOT returned, so it cannot affect the resolver
       ext_mt::ext(self.mt_token.clone())
           .with_static_gas(WITHDRAW_GAS)
           .withdraw(/* ... */)
           .then(Self::ext(env::current_account_id())
               .with_static_gas(CALLBACK_GAS)
               .on_withdraw_complete(/* ... */));

       PromiseOrValue::Value(vec![U128(0); token_ids.len()])
   }
   ```

   Then `on_withdraw_complete` handles `withdraw` failure inside the bridge, by recording a claimable or retryable balance. It never relies on the token contract's refund.

2. **If you must return the promise**, make `on_withdraw_complete` unable to fail. Use `#[callback_result]` instead of `#[callback_unwrap]`, no `unwrap`/`require!`, generous static gas, and always return `vec![U128(0); n]`. Also require enough prepaid gas in `mt_on_transfer` so a gas shortage panics there, before anything is scheduled.

3. **Don't let users set gas freely.** Enforce a minimum high enough for the whole chain.

4. **Check the resolvers.** Verify that `mt_resolve_transfer` and `mt_resolve_withdraw` treat `Failed` correctly given side effects that already happened. Also check what the refund cap is based on.

5. **Relayer:** trigger release only on the final successful outcome of the full receipt tree, not on intermediate logs. Parse `msg` with the same strict rules as the contract.

6. **Test it.** In near-workspaces, fuzz attached gas in small steps across the whole range. After each run, check that `user_refunded XOR withdraw_succeeded` holds. Also test duplicate token ids, swapped order, malformed `msg`, and an upgrade between blocks while receipts are in flight.

The key point: on NEAR, a returned promise's result becomes your function's result. If your return value has to stay independent of `withdraw`, don't return the `withdraw` promise.
