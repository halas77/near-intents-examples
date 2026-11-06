# Silent failures in NEAR Protocol and Rust

A silent failure is a situation where code, a transaction, a promise, or an operation fails to achieve its intended result without the failure being clearly exposed to the caller.

For blockchain security research, I would divide this into five categories:

1. Failure without transaction failure: the original transaction succeeds, but a downstream receipt or callback fails.
2. Failure hidden by error handling: an error occurs, but the program ignores it or converts it into a normal value.
3. Partial execution: some operations succeed while others fail, leaving inconsistent state.
4. Incorrect success interpretation: the program treats an invalid, empty, incomplete, or unexpected result as success.
5. Silent data corruption: the program continues executing with altered, truncated, stale, or defaulted data.

These categories are particularly important in NEAR because cross-contract communication uses asynchronous receipts, rather than executing every contract call as one atomic operation. A successful handoff does not prove that the downstream operation succeeded.&#x20;

[image](https://www.google.com/s2/favicons?domain=https://github.com&sz=32)

GitHub+1

Important scope: There is no finite list of every possible silent failure in Rust or NEAR. The following is a security-oriented catalog of identifiable mechanisms, programming mistakes, runtime behaviors, and audit patterns. I distinguish actual protocol behavior from bugs developers can introduce.

## 1. NEAR Protocol silent-failure mechanisms

Highest audit priority

&#x20;Asynchronous execution, promise handling, callbacks, gas, and state reconciliation.

### A. Receipt and cross-contract execution failures

| #   | Failure mechanism                                      | What happens silently                                                                                                                                                               |
| --- | ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Initial transaction succeeds, downstream receipt fails | The initial contract call creates a receipt successfully, but a later contract call fails. An explorer showing only the initial transaction can make the operation look successful. |
| 2   | Non-atomic cross-contract execution                    | Contract A updates its state, then calls B. B fails, but A's earlier state update is not automatically reversed.                                                                    |
| 3   | Missing compensation callback                          | A transfer or external operation fails, but there is no callback to restore the initiating contract's accounting.                                                                   |
| 4   | Callback does not revert optimistic state              | The original method deducts balances, deletes orders, or locks funds before making a promise. The callback detects failure but doesn't undo the state.                              |
| 5   | Callback itself panics                                 | The callback is supposed to restore state after a failed promise, but its own assertion or panic prevents recovery.                                                                 |
| 6   | Callback runs but ignores failure                      | The callback executes normally, logs the failure, and returns without restoring state.                                                                                              |
| 7   | Callback recovery is incomplete                        | Only some of the original state is restored, leaving balance, accounting, and status fields inconsistent.                                                                           |
| 8   | Wrong promise dependency                               | A callback waits for a different promise than the one whose result it uses.                                                                                                         |
| 9   | Wrong promise-result index                             | Multiple promises exist, but the callback reads index `0` without mapping the indices to the correct operations.                                                                    |
| 10  | Incorrect promise-result count assumption              | A callback assumes one result exists when the execution actually supplies multiple results or a different dependency arrangement.                                                   |

NEAR's receipt model explicitly distinguishes action receipts from data receipts. An unsuccessful remote execution is represented as a failed promise result, not as an automatic rollback of every previous receipt.&#x20;

[image](https://www.google.com/s2/favicons?domain=https://github.com&sz=32)

GitHub+2

A real audit example: BlockSec identified a confirmed and fixed NearOinDao issue in which the contract performed operations such as `storage_deposit` and `ft_transfer`, but did not revert contract state when the cross-contract operation failed. The report specifically documented this as a potential user asset-loss issue.&#x20;

[image](https://www.google.com/s2/favicons?domain=https://blocksec.com&sz=32)

BlockSec Blog+1

### B. Promise-result interpretation failures

| #   | Failure mechanism                                               | Dangerous behavior                                                                                                                         |
| --- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| 11  | Ignoring `PromiseResult::Failed`                                | The caller continues as if the remote operation succeeded.                                                                                 |
| 12  | Checking only whether a result exists                           | A returned result is mistaken for a successful result.                                                                                     |
| 13  | Checking only `is_promise_success()` and discarding the boolean | The callback has a success indicator but doesn't use it to protect state transitions.                                                      |
| 14  | Using `promise_result_as_success()` incorrectly                 | The returned `Option` is converted to a default value or ignored.                                                                          |
| 15  | Treating `Successful(bytes)` as business success                | The remote contract returns bytes successfully, but the bytes encode `false`, zero, a rejection, or another unsuccessful business outcome. |
| 16  | Incorrect JSON deserialization                                  | A successful remote call returns data in a format the caller does not expect.                                                              |
| 17  | Invalid callback value converted to zero                        | A failed parser is treated as an amount of zero, a false condition, or an empty result.                                                    |
| 18  | Empty successful result                                         | An empty byte vector is accepted as a valid result without checking the expected return type.                                              |
| 19  | Oversized promise result                                        | Result processing consumes too much gas or memory and causes the callback to fail.                                                         |
| 20  | Incorrect callback argument mapping                             | Multiple `#[callback_result]` or `#[callback_unwrap]` arguments are mapped to the wrong results.                                           |

There are important distinctions in NEAR SDK:

- `PromiseResult::Failed` indicates a failed promise.
- `PromiseResult::Successful(Vec<u8>)` indicates successful execution with a byte result. It does not validate the business meaning of those bytes.
- `#[callback_result]` gives the contract a `Result<T, PromiseError>` for handling promise failure.
- `#[callback_unwrap]` panics when the promise fails or its result cannot be processed.
- `env::promise_result()` is deprecated in favor of `promise_result_checked()` because an unbounded result can cause out-of-gas errors when reading untrusted data.

Sources:&#x20;

[image](https://www.google.com/s2/favicons?domain=https://docs.rs&sz=32)

Rust+3

### C. Gas and execution-resource failures

These are especially interesting because an application can correctly construct a promise but still fail during a later stage.

| #   | Failure mechanism                           | Consequence                                                                                                       |
| --- | ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| 21  | Insufficient gas for the remote call        | The remote contract does not complete its intended operation.                                                     |
| 22  | Insufficient callback gas                   | The remote call may succeed, but its callback cannot finish.                                                      |
| 23  | Insufficient gas for refund logic           | A callback cannot perform the required balance restoration.                                                       |
| 24  | No prepaid-gas validation                   | The initiating method schedules a promise chain without reserving enough gas for all stages.                      |
| 25  | Excessive callback computation              | A callback reaches its gas limit while performing calculations or iterating over collections.                     |
| 26  | Unbounded promise-result reading            | A large external return value exhausts callback resources.                                                        |
| 27  | Storage expansion without funding           | A contract grows its persistent state without verifying that sufficient balance is available for storage staking. |
| 28  | Insufficient balance for generated receipts | The contract executes logic but cannot fund the resulting transfers or actions.                                   |
| 29  | Refund operation fails                      | The callback attempts to send money back but does not correctly handle the failed refund.                         |
| 30  | Cleanup operation runs out of gas           | Pending entries, locks, or temporary state remain in storage.                                                     |

A particularly useful audit rule comes from Rustle: NEP-141 `ft_transfer_call` should check whether prepaid gas is sufficient for both `ft_on_transfer` and `ft_resolve_transfer`.&#x20;

[image](https://www.google.com/s2/favicons?domain=https://github.com&sz=32)

GitHub+1

### D. NEP-141 and token-related silent failures

These deserve their own section because token transfers involve several asynchronous stages.

| #   | Failure mechanism                                                | Potential consequence                                                                        |
| --- | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| 31  | `ft_on_transfer` fails but resolver is not implemented correctly | The original transfer may not be refunded correctly.                                         |
| 32  | `ft_resolve_transfer` ignores a failed promise                   | Funds can remain incorrectly attributed to the receiver.                                     |
| 33  | Resolver receives malformed unused-token amount                  | The refund amount is miscalculated.                                                          |
| 34  | Resolver interprets invalid data as zero                         | A receiver's returned amount is treated as fully consumed when it should have been refunded. |
| 35  | Receiver spends more tokens than it should                       | The refund can be limited by the receiver's remaining balance.                               |
| 36  | Sender or receiver is unregistered                               | Internal token-account handling produces unexpected default or failure behavior.             |
| 37  | Registration is silently created with zero balance               | A missing-account condition is hidden and storage costs may be charged to the contract.      |
| 38  | Token contract does not follow NEP-141 result conventions        | Another contract interprets a valid-looking response incorrectly.                            |
| 39  | Resolver authorization is incorrect                              | An unauthorized account can invoke a resolution function or cause incorrect reconciliation.  |
| 40  | Resolver is not reached or fails                                 | The transfer remains unreconciled even though the original transfer stage completed.         |

The NEP-141 standard requires the token contract to resolve transfer calls, revert the transfer when the promise chain fails, and return unused tokens when the receiver reports them. This makes the resolver a critical security boundary.&#x20;

[image](https://www.google.com/s2/favicons?domain=https://github.com&sz=32)

GitHub+2

One particularly subtle implementation error is treating a missing token account as a zero balance instead of rejecting an unregistered receiver. Rustle documents this exact pattern: using `.unwrap_or(0)` rather than explicitly failing on an unregistered account can create an account entry and cause the contract to sponsor its storage.&#x20;

[image](https://www.google.com/s2/favicons?domain=https://github.com&sz=32)

GitHub+1

### E. Persistent storage and state failures

| #   | Failure mechanism                               | Potential consequence                                                                     |
| --- | ----------------------------------------------- | ----------------------------------------------------------------------------------------- |
| 41  | Duplicate collection prefixes                   | Two collections access overlapping storage namespaces.                                    |
| 42  | Incorrect storage prefix after contract upgrade | Existing storage becomes inaccessible or interpreted incorrectly.                         |
| 43  | Incorrect Borsh state migration                 | Previously stored data cannot be interpreted using the new contract's schema.             |
| 44  | Incorrect collection indexing                   | Primary data and secondary index structures become inconsistent.                          |
| 45  | Ignored `remove()` return value                 | Code assumes an entry was removed when it was not present.                                |
| 46  | Ignored storage-write result                    | An unexpected old or missing value is not accounted for.                                  |
| 47  | Insufficient storage deposit                    | New records cannot be safely funded.                                                      |
| 48  | Incorrect storage-unregister handling           | User balances, refunds, or registration status become inconsistent.                       |
| 49  | Incorrect state cleanup after failed promise    | Temporary records remain and can block future operations.                                 |
| 50  | Persistent-state deserialization failure        | A contract upgrade or incompatible stored value causes a later method invocation to fail. |

Rustle explicitly detects duplicate collection identifiers. Its documentation demonstrates two collections, `orders` and `users`, incorrectly initialized with the same storage prefix.&#x20;

[image](https://www.google.com/s2/favicons?domain=https://github.com&sz=32)

GitHub+1

## 2. Rust-language silent-failure mechanisms

This section concerns Rust itself, not only NEAR's implementation of Rust contracts.

### A. Ignored errors and suppressed return values

These are among the most important patterns to search for.

| #   | Pattern                        | How failure gets hidden                                                              |
| --- | ------------------------------ | ------------------------------------------------------------------------------------ |
| 51  | Ignored `Result`               | The operation fails but the error is discarded.                                      |
| 52  | `let _ = operation()`          | Explicitly discards the result.                                                      |
| 53  | `.ok()`                        | Converts `Result` into `Option`, losing the error information.                       |
| 54  | `.unwrap_or(default)`          | Replaces an error with an apparently valid default.                                  |
| 55  | `.unwrap_or_default()`         | Converts errors into empty, zero, or default values.                                 |
| 56  | `.unwrap_or(false)`            | Turns an error into a negative boolean result.                                       |
| 57  | `.unwrap_or(0)`                | Turns a failed lookup or calculation into zero.                                      |
| 58  | `.unwrap_or_else()`            | An error handler substitutes a value instead of propagating the failure.             |
| 59  | Ignored `Option`               | Missing data is not detected.                                                        |
| 60  | Ignored boolean return         | An operation can return `false` without changing anything, but the caller continues. |
| 61  | Error swallowed inside `match` | The failure branch does nothing or logs without changing execution.                  |
| 62  | Error converted into success   | An error is transformed into `Ok(default_value)`.                                    |

Example:

```
// Dangerous: silently ignores missing account
let balance = accounts.get(&account_id).unwrap_or(0);

// Dangerous: silently converts any error into zero
let amount = parse_amount(input).unwrap_or_default();

// Dangerous: removes a record but never verifies it existed
records.remove(&record_id);

// Dangerous: loses the original error
let parsed = parse_amount(input).ok();
```

The Rust standard library marks `Result` as `must_use`, but this is a compiler warning mechanism, not a guarantee that the programmer handles errors. Explicitly discarding a result remains possible.&#x20;

[image](https://www.google.com/s2/favicons?domain=https://doc.rust-lang.org&sz=32)

Rust+1

### B. Integer and numeric silent corruption

| #   | Failure mechanism                             | Consequence                                                             |
| --- | --------------------------------------------- | ----------------------------------------------------------------------- |
| 63  | Integer overflow in release builds            | Arithmetic can wrap rather than panic.                                  |
| 64  | Integer underflow                             | A subtraction produces an incorrect large or wrapped value.             |
| 65  | Narrowing integer casts                       | High bits are discarded.                                                |
| 66  | Signed-to-unsigned conversion                 | Negative values can become unexpectedly large.                          |
| 67  | Unsigned-to-signed conversion                 | Values outside the signed range can be misinterpreted.                  |
| 68  | `wrapping_add`                                | Overflow is intentionally converted into modular arithmetic.            |
| 69  | `wrapping_sub`                                | Underflow produces a wrapped result.                                    |
| 70  | `saturating_add`                              | Values stop at the maximum instead of reporting overflow.               |
| 71  | `saturating_sub`                              | Underflow becomes zero.                                                 |
| 72  | Precision loss from floating-point arithmetic | Financial calculations produce inaccurate balances.                     |
| 73  | Division before multiplication                | Integer truncation loses precision.                                     |
| 74  | Incorrect rounding                            | Floor/ceil behavior differs from the intended economic rule.            |
| 75  | Division by zero hidden by fallback logic     | A default value is substituted instead of exposing invalid computation. |
| 76  | NaN comparison behavior                       | Comparisons can produce unexpected branches.                            |
| 77  | Decimal conversion mismatch                   | Token decimal units are calculated incorrectly.                         |

Especially important: Rust's default overflow behavior depends on compilation settings. The Rust book documents panics for overflow in debug builds and wrapping behavior in standard release builds. `checked_*`, `wrapping_*`, and `saturating_*` are different behaviors and must be selected intentionally.&#x20;

[image](https://www.google.com/s2/favicons?domain=https://doc.rust-lang.org&sz=32)

The Rust Programming Language+2

For smart contracts, examine every calculation involving:

- `u128` balances and supplies.
- `U128` serialized values.
- Shares and reward calculations.
- Fees and percentages.
- Exchange rates.
- Token decimal conversion.
- Block timestamp differences.
- Gas and storage arithmetic.

### C. Serialization and deserialization failures

| #   | Failure mechanism                | Consequence                                                                  |
| --- | -------------------------------- | ---------------------------------------------------------------------------- |
| 78  | Serde ignores unknown fields     | Incorrect parameter names may go unnoticed.                                  |
| 79  | `#[serde(default)]`              | Missing input fields silently receive default values.                        |
| 80  | `#[serde(skip)]`                 | A field is omitted from serialization and deserialization.                   |
| 81  | `#[serde(skip_deserializing)]`   | Incoming data does not populate the expected field.                          |
| 82  | `#[serde(skip_serializing)]`     | A field is omitted from outgoing data.                                       |
| 83  | Incorrect `rename`               | Producer and consumer expect different JSON field names.                     |
| 84  | Incorrect `alias`                | Multiple external representations map into one field unexpectedly.           |
| 85  | Incorrect `flatten`              | Nested structures can be interpreted differently than intended.              |
| 86  | Borsh schema incompatibility     | Stored binary data is no longer correctly interpreted.                       |
| 87  | JSON number/string mismatch      | One contract returns a number while another expects a decimal string.        |
| 88  | Serialization errors suppressed  | An invalid value becomes an empty or fallback response.                      |
| 89  | UTF-8 lossy conversion           | Invalid bytes become replacement characters rather than triggering an error. |
| 90  | Incompatible enum representation | Different versions interpret variants differently.                           |

A particularly dangerous Serde detail: unknown JSON fields are ignored by default for self-describing formats unless `deny_unknown_fields` is enabled. Missing fields can also receive defaults through `#[serde(default)]`.&#x20;

[image](https://www.google.com/s2/favicons?domain=https://serde.rs&sz=32)

Serde+1

Example:

```
#[derive(Deserialize)]
struct WithdrawArgs {
    #[serde(default)]
    amount: u128,

    #[serde(default)]
    recipient: Option<AccountId>,
}
```

An input with missing fields can deserialize into a valid Rust structure without necessarily triggering a parsing error. That is not automatically a vulnerability, but becomes dangerous when those defaults authorize or alter financial operations.

### D. Collections and iterator behavior

| #   | Failure mechanism                   | Silent effect                                                                  |
| --- | ----------------------------------- | ------------------------------------------------------------------------------ |
| 91  | `HashMap::insert()`                 | Existing value is replaced unless the return value is checked.                 |
| 92  | `HashMap::remove()`                 | Missing key returns `None`.                                                    |
| 93  | `HashSet::insert()`                 | Duplicate insertion returns `false`.                                           |
| 94  | `HashSet` deduplication             | Duplicate items disappear.                                                     |
| 95  | `filter_map()`                      | Items returning `None` disappear from the output.                              |
| 96  | `flatten()`                         | Missing or empty inner values contribute nothing.                              |
| 97  | `zip()`                             | Iteration stops at the shorter collection.                                     |
| 98  | `find()`                            | Only the first match is returned.                                              |
| 99  | `take()`                            | Remaining elements are silently excluded.                                      |
| 100 | `collect::<HashMap<_, _>>()`        | Duplicate keys can overwrite earlier values.                                   |
| 101 | `retain()`                          | Elements failing the predicate are removed.                                    |
| 102 | Arbitrary `HashMap` iteration order | Logic relying on a stable first or last element can choose an unexpected item. |

Rust's `HashMap` documentation explicitly describes its key/value iteration order as arbitrary. This matters when order is used for selecting recipients, allocation priorities, or constructing results that are expected to be stable.&#x20;

[image](https://www.google.com/s2/favicons?domain=https://doc.rust-lang.org&sz=32)

Rust

### E. Asynchronous Rust and task failures

This is particularly important for NEAR relayers, indexers, backend services, and off-chain transaction processors.

| #   | Failure mechanism            | How it appears                                                                     |
| --- | ---------------------------- | ---------------------------------------------------------------------------------- |
| 103 | Future never awaited         | Async operation never actually executes.                                           |
| 104 | Dropped `JoinHandle`         | Background task becomes detached and can no longer be joined through that handle.  |
| 105 | Ignored `JoinError`          | A task panicked but the caller does not inspect the failure.                       |
| 106 | Ignored channel send error   | Message is not delivered because the receiving side is gone.                       |
| 107 | Ignored `try_send()` error   | Message is dropped or not queued because the channel is full or closed.            |
| 108 | Timeout cancellation         | Future is dropped and its local execution stops.                                   |
| 109 | `select!` cancellation       | A competing branch wins and another future is cancelled.                           |
| 110 | Dropped spawned task         | Work may outlive the caller without any result being observed.                     |
| 111 | Nested `Result` handling     | `Result<Result<T, E>, JoinError>` is only partially checked.                       |
| 112 | Panic inside background task | The task terminates without an error being propagated to the business-logic layer. |

Two Rust-specific facts are crucial:

- Creating a future does not run it until it is polled.
- Dropping a Tokio `JoinHandle` detaches the task; it does not automatically cancel it.

[image](https://www.google.com/s2/favicons?domain=https://doc.rust-lang.org&sz=32)

Rust+1

This gives you an additional target beyond smart contracts: the Rust services that submit, monitor, retry, and reconcile NEAR transactions.

### F. Unsafe Rust and memory corruption

| #   | Failure mechanism             | Potential consequence                                   |
| --- | ----------------------------- | ------------------------------------------------------- |
| 113 | Uninitialized-memory reads    | Invalid or unpredictable values.                        |
| 114 | Dangling pointers             | Incorrect memory access.                                |
| 115 | Misaligned pointer operations | Undefined behavior.                                     |
| 116 | Invalid `transmute`           | Produces an invalid Rust value.                         |
| 117 | Breaking aliasing rules       | Compiler optimizations can produce unexpected behavior. |
| 118 | Data races                    | Undefined behavior.                                     |
| 119 | Incorrect FFI ABI             | Incorrect arguments, return values, or memory handling. |
| 120 | Incorrect `MaybeUninit` usage | Uninitialized data may be interpreted as initialized.   |
| 121 | Invalid inline assembly       | Incorrect program behavior or memory corruption.        |

Rust's official reference classifies these as undefined behavior. Unlike ordinary `Result` failures, undefined behavior does not promise an error return or a controlled panic.&#x20;

[image](https://www.google.com/s2/favicons?domain=https://doc.rust-lang.org&sz=32)

The Rust Reference+1

These deserve investigation when a NEAR contract depends on unsafe code or imported libraries, although they are less common than promise, accounting, serialization, and arithmetic mistakes.

## 3. Less obvious NEAR/Rust failure mechanisms worth investigating

These are especially interesting for finding uncommon vulnerabilities in audit reports.

| #   | Mechanism                                          | Why it is interesting                                                                                                                                                         |
| --- | -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 122 | Failure reason erased by NEAR promise semantics    | `PromiseResult::Failed` does not contain the remote error message. A panic, out-of-gas failure, and unavailable remote contract can become indistinguishable to the callback. |
| 123 | Business rejection confused with execution failure | A contract returns a failed receipt for a legitimate business rejection, making it indistinguishable from an execution problem.                                               |
| 124 | `#[handle_result]` failure conversion              | An application-level `Err` can become a panic and therefore a generic failed promise.                                                                                         |
| 125 | Concurrent receipt ordering assumptions            | Multiple independently scheduled receipts execute without a guaranteed global execution order.                                                                                |
| 126 | Partial success in a promise group                 | One operation succeeds and another fails. The application incorrectly assumes the group is atomic.                                                                            |
| 127 | Missing timeout recovery                           | A pending operation never reaches its expected final state because cleanup depends on a response that never arrives.                                                          |
| 128 | Timeout callback failure                           | Even the timeout recovery mechanism fails, leaving pending records orphaned.                                                                                                  |
| 129 | Lost business context in callback errors           | The callback knows an operation failed but does not know whether it should retry, refund, or permanently reject it.                                                           |
| 130 | Dynamic gas allocation assumptions                 | A promise relies on available weighted gas that is not sufficient for all execution paths.                                                                                    |
| 131 | Event and log inconsistency                        | A log or event is treated as proof of a completed business operation, although another receipt or accounting stage has failed.                                                |
| 132 | Stale pending-operation state                      | A previous operation's callback or completion state is incorrectly reused by a later operation.                                                                               |

One particularly interesting example is the NEAR MPC attestation-verifier implementation. Its design explicitly distinguishes a business rejection from a failed receipt: because `PromiseResult::Failed` cannot communicate the rejection reason, it returns a dedicated result enum as successful serialized data. It also uses timeout cleanup to handle non-response and execution failure.&#x20;

[image](https://www.google.com/s2/favicons?domain=https://github.com&sz=32)

GitHub+2

This is an excellent research direction: how can a system distinguish an unsuccessful business operation from an unsuccessful contract execution?

## 4. Other security findings closely related to silent failures

Not every issue below is technically a silent failure, but each can trigger incorrect state transitions or hide an unsuccessful operation.

Rustle, the NEAR Rust static analyzer developed by BlockSec, is particularly useful here.

Its documented detector families include:

| Detector                | What it identifies                                     |
| ----------------------- | ------------------------------------------------------ |
| `unused-ret`            | Unused or unchecked function return values             |
| `lock-callback`         | Callback panics that prevent state recovery            |
| `dup-collection-id`     | Duplicate persistent collection identifiers            |
| `unregistered-receiver` | Incorrect handling of unregistered token accounts      |
| `prepaid-gas`           | Missing prepaid-gas validation                         |
| `storage-gas`           | Missing storage-expansion balance checks               |
| `unclaimed-storage-fee` | Incorrect storage-unregistration handling              |
| `promise-result`        | Locations where promise results are accessed           |
| `ext-call`              | Cross-contract calls                                   |
| `unsafe-math`           | Arithmetic without sufficient overflow protection      |
| `div-before-mul`        | Precision loss from arithmetic ordering                |
| `round`                 | Incorrect or unspecified rounding                      |
| `incorrect-json-type`   | Incorrect JSON parameter or return types               |
| `non-private-callback`  | Callback functions without appropriate private access  |
| `reentrancy`            | Potentially unsafe interleaving of contract operations |

Sources:&#x20;

[image](https://www.google.com/s2/favicons?domain=https://github.com&sz=32)

GitHub+1

Repository: [BlockSec Rustle — NEAR Rust static analyzer](https://github.com/blocksecteam/rustle?utm_source=chatgpt.com).

I would use this as a starting point, not as a complete detector. It cannot establish that every ignored return value is exploitable or discover every failure hidden behind custom application logic.

## 5. Highest-priority audit targets

For actual vulnerability hunting, I would rank the mechanisms as follows.

Priority 1 — Extremely important

Critical research area

1. Promise result ignored or interpreted incorrectly.
2. Callback fails to restore optimistic state.
3. Callback panics during recovery.
4. Promise succeeds at the transaction handoff but fails downstream.
5. Token resolver incorrectly handles failed or malformed receiver results.
6. Callback runs out of gas.
7. Receiver spends funds before refund reconciliation.

   Priority 2 — Very interesting

8. Missing account converted to zero balance.
9. Duplicate collection prefixes.
10. Successful receipt with invalid or unexpected return data.
11. Promise index confusion.
12. Concurrent receipt ordering assumptions.
13. Integer overflow, underflow, and narrowing casts.
14. Missing storage-funding checks.
15. Missing pending-operation cleanup.

    Priority 3 — Unusual Rust behavior

16. `Result` converted into `Option`.
17. `unwrap_or_default()` hiding errors.
18. Ignored boolean return values.
19. `filter_map()` silently removing records.
20. `zip()` truncating processing.
21. Serialization defaults and ignored JSON fields.
22. Async task failures that never reach the caller.
23. Arbitrary collection iteration order.
24. Unsafe code and invalid memory assumptions.

## 6. Practical search patterns for auditing Rust NEAR repositories

Here is a useful initial search strategy.

### A. Promise and callback patterns

Search for:

```
rg -n \
'PromiseResult|promise_result|promise_result_checked|promise_results_count|is_promise_success|promise_result_as_success|callback_result|callback_unwrap|handle_result|\.then\(|\.and\(' \
contracts/
```

For every result, investigate:

- Is the failed branch handled?
- Is the callback private?
- Is the callback capable of panicking?
- Is the correct promise-result index used?
- Is the original state restored?
- Are refunds checked?
- Can the callback run out of gas?
- Does a successful byte result actually represent business success?

### B. Rust error suppression patterns

```
rg -n \
'unwrap_or_default|unwrap_or_else|unwrap_or\(|\.ok\(\)|let _ =|map_err|catch_unwind|filter_map|\.zip\(|\.remove\(|\.insert\(' \
contracts/
```

Don't automatically classify every match as a vulnerability. Trace the error and returned value to its final consumer.

### C. Arithmetic and serialization patterns

```
rg -n \
'as u8|as u16|as u32|as u64|as u128|wrapping_|saturating_|checked_|f32|f64|serde\(default\)|skip_deserializing|skip_serializing|from_utf8_lossy' \
contracts/
```

Look especially at any operation that modifies:

- User balances.
- Total supply.
- Token shares.
- Reward calculations.
- Withdrawable amounts.
- Pending withdrawals.
- Storage deposits.
- Refund amounts.

### D. NEAR storage and gas patterns

```
rg -n \
'storage_usage|storage_byte_cost|attached_deposit|prepaid_gas|used_gas|Gas::|LookupMap::new|UnorderedMap::new|UnorderedSet::new|Vector::new' \
contracts/
```

Check collection-prefix uniqueness, storage funding, callback gas reservations, and the interaction between persistent indexes.

## 7. How to detect silent failures in real NEAR transactions

This is just as important as source-code review.

Never investigate only the transaction hash's top-level status.

Trace the complete receipt graph:

Initial transaction

SuccessReceiptId / successful handoff

Contract A receipt

State update and promise creation

Contract B receipt

Successful or failed execution

Resolver / callback receipt

Promise result and recovery behavior

Expected

State reconciled

Correct balance, refund and status

Failure path

State inconsistent

Lost refund, stale lock or wrong balance

A useful real-world demonstration is FastNEAR's transaction-analysis documentation: it shows an `ft_transfer_call` whose initial handoff succeeds, while a descendant `ft_on_transfer` panics because the DEX is paused. The resolver still runs. Looking only at the first transaction would conceal the important part of the execution.&#x20;

[image](https://www.google.com/s2/favicons?domain=https://docs.fastnear.com&sz=32)

Builder Docs+1

Useful resources:

- [NEAR developer documentation](https://docs.near.org/?utm_source=chatgpt.com)
- [NearBlocks explorer](https://nearblocks.io/?utm_source=chatgpt.com)
- [NEAR Rust SDK reference](https://docs.rs/near-sdk/latest/near_sdk/?utm_source=chatgpt.com)
- [NEAR runtime specifications](https://github.com/near/nearcore/tree/master/docs/RuntimeSpec?utm_source=chatgpt.com)
- [NEP-141 fungible token standard](https://github.com/near/NEPs/blob/master/neps/nep-0141.md?utm_source=chatgpt.com)
- [Rustle static analyzer](https://github.com/blocksecteam/rustle?utm_source=chatgpt.com)

## 8. Applying this to your NEAR bridge investigation

For the multi-stage flow you've been tracing:

`mt_withdraw` → `mt_batch_transfer_call` → `mt_on_transfer` → `mt_resolve_transfer` → `mt_resolve_withdraw`

I would specifically investigate the following failure boundaries:

| Transition                                    | What to investigate                                                                                                                  |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `mt_withdraw` → `mt_batch_transfer_call`      | Incorrect return handling, state updates before promise completion, insufficient gas.                                                |
| `mt_batch_transfer_call` → `mt_on_transfer`   | Token receiver registration, receiver response, attached gas, message decoding.                                                      |
| `mt_on_transfer` → `mt_resolve_transfer`      | Failure interpretation, malformed unused amount, refund calculations, receiver balance changes.                                      |
| `mt_resolve_transfer` → `mt_resolve_withdraw` | Whether the callback result accurately represents the actual transfer, whether withdrawal state is finalized too early.              |
| Entire flow                                   | Missing callbacks, repeated resolution, stale pending records, unexpected receipt ordering, failed cleanup and incorrect accounting. |

The most important invariant to test is:

A withdrawal must never be considered successfully completed merely because the previous contract successfully scheduled the next promise.

Also compare the actual token balances, internal accounting, pending operation records, and resolver results. A successful callback receipt alone is not proof that every expected financial effect occurred.
