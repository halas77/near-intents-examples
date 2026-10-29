// Dependencies: none. This file uses only the Rust standard library and needs no `use` statements.
// Build: rustc --edition 2021 mt_resolve_transfer_readable.rs

/*
 * Readable Rust reference structure for NEP-245 mt_resolve_transfer.
 *
 * This file replaces wasm2c's generated locals, labels, and branches with
 * ordinary Rust control flow. It is an application-level reference, NOT a
 * behavior-equivalent decompilation of the supplied WebAssembly module.
 *
 * Runtime responsibilities:
 *   - read predecessor/current account IDs and the receiver promise result;
 *   - expose receiver balances for each token;
 *   - apply every refund, restore the applicable approval snapshots, and emit
 *     transfer events atomically in the host transaction.
 *
 * NEP-245 rule represented here:
 *   - only the contract itself may invoke the resolver;
 *   - a failed or invalid receiver callback result refunds the full transfer;
 *   - a valid callback result specifies the unused amount for each token;
 *   - refunds are capped by both the unused amount and the receiver's current
 *     balance, because the receiver may have spent tokens during the callback;
 *   - return values report the amount actually spent (sent minus refunded).
 *
 * Approval snapshots are passed to the runtime adapter. The adapter must restore
 * approvals only for the amount actually refunded, according to the contract's
 * approval-management rules. If applying a resolution fails, the host must abort
 * the transaction so no partial balance or approval changes are committed.
 */

#![allow(dead_code)]

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MtU128 {
    pub high: u64,
    pub low: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MtResolveStatus {
    MtResolveOk = 0,
    MtResolveInvalidArgument,
    MtResolveInvalidRuntime,
    MtResolveNotSelfCall,
    MtResolvePromiseReadFailed,
    MtResolveBalanceReadFailed,
    MtResolveApplyFailed,
    MtResolveOutOfMemory,
}

#[derive(Debug, Clone, Copy)]
pub struct MtApprovalEntry<'a> {
    pub owner_id: Option<&'a str>,
    pub approval_id: u64,
    pub approved_amount: MtU128,
}

#[derive(Debug, Clone, Copy)]
pub struct MtApprovalSnapshot<'a> {
    /* None (NULL) means no approval snapshot was provided for this token. */
    pub entries: Option<&'a [MtApprovalEntry<'a>]>,
}

#[derive(Debug, Clone, Copy)]
pub struct MtResolveItem<'a> {
    pub token_id: Option<&'a str>,
    pub transferred_amount: MtU128,

    /* Owner before mt_transfer_call. Normally sender_id; may differ when an
     * approved account initiated the transfer. None (NULL) means sender_id. */
    pub original_owner_id: Option<&'a str>,

    /* Original approvals cleared during the transfer, if the contract uses
     * NEP-245 approval management. */
    pub approvals: MtApprovalSnapshot<'a>,
}

#[derive(Debug, Clone, Copy)]
pub struct MtResolveRequest<'a> {
    pub sender_id: Option<&'a str>,
    pub receiver_id: Option<&'a str>,
    /* None (NULL) or an empty slice is rejected during validation. */
    pub items: Option<&'a [MtResolveItem<'a>]>,
}

impl<'a> MtResolveRequest<'a> {
    fn item_count(&self) -> usize {
        self.items.map_or(0, |items| items.len())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MtPromiseOutcome {
    MtPromiseFailed = 0,
    MtPromiseSuccess,
    MtPromiseInvalidResult,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MtPromiseResult {
    pub outcome: MtPromiseOutcome,

    /* For a successful, valid mt_on_transfer result, this array contains the
     * unused amount for each corresponding item. The array is owned by the
     * promise result (see the notes for why it is not borrowed from the runtime)
     * and remains valid during mt_resolve_transfer(). None (NULL) means no
     * unused amounts were provided. */
    pub unused_amounts: Option<Vec<MtU128>>,
}

pub trait MtResolveRuntime {
    /* Returns the predecessor account ID; None (NULL) means not available. */
    fn predecessor_account_id(&self) -> Option<String>;

    /* Returns the current account ID; None (NULL) means not available. */
    fn current_account_id(&self) -> Option<String>;

    /* Return the promise result from the receiver's mt_on_transfer call. A
     * failed promise, malformed JSON, or invalid result must be represented as
     * FAILED or INVALID_RESULT, so the full transfer is rolled back. */
    fn read_receiver_result(&mut self, result_out: &mut MtPromiseResult) -> MtResolveStatus;

    /* Read the receiver's current balance for this token. */
    fn balance_of(
        &mut self,
        account_id: &str,
        token_id: &str,
        balance_out: &mut MtU128,
    ) -> MtResolveStatus;

    /* Atomically apply the calculated refunds, restore approvals in proportion
     * to each item's actual refund, and emit the appropriate transfer event(s).
     * Return MtResolveOk on success. Any other result must cause the host
     * transaction to be aborted/rolled back; returning an error alone is not a
     * substitute for rollback on a non-transactional host. */
    fn apply_resolution(
        &mut self,
        request: &MtResolveRequest,
        refund_amounts: &[MtU128],
        spent_amounts: &[MtU128],
    ) -> MtResolveStatus;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MtResolveResult {
    pub status: MtResolveStatus,
    pub message: &'static str,
}

#[derive(Debug, Clone, Copy)]
struct MtWorkingBalance<'a> {
    token_id: &'a str,
    remaining_balance: MtU128,
}

fn mt_resolve_result(status: MtResolveStatus, message: &'static str) -> MtResolveResult {
    MtResolveResult { status, message }
}

fn mt_is_nonempty(text: Option<&str>) -> bool {
    matches!(text, Some(text) if !text.is_empty())
}

fn mt_u128_compare(left: MtU128, right: MtU128) -> i32 {
    if left.high < right.high {
        return -1;
    }
    if left.high > right.high {
        return 1;
    }
    if left.low < right.low {
        return -1;
    }
    if left.low > right.low {
        return 1;
    }
    0
}

fn mt_u128_min(left: MtU128, right: MtU128) -> MtU128 {
    if mt_u128_compare(left, right) <= 0 {
        left
    } else {
        right
    }
}

/* Requires left >= right. */
fn mt_u128_subtract(left: MtU128, right: MtU128) -> MtU128 {
    /* Wrapping operations match the unsigned C arithmetic and avoid debug-mode
     * overflow panics when the precondition is violated. */
    let borrow: u64 = if left.low < right.low { 1 } else { 0 };
    let low = left.low.wrapping_sub(right.low);
    let high = left.high.wrapping_sub(right.high).wrapping_sub(borrow);
    MtU128 { high, low }
}

fn mt_u128_zero() -> MtU128 {
    MtU128 { high: 0, low: 0 }
}

/* Convenience constructor for a value that fits in the low 64 bits. */
fn mt_u128_from_low(low: u64) -> MtU128 {
    MtU128 { high: 0, low }
}

fn mt_runtime_is_complete(runtime: Option<&dyn MtResolveRuntime>) -> bool {
    /* Every operation is a trait method, so a present runtime is complete. */
    runtime.is_some()
}

fn mt_promise_result_is_valid(promise: Option<&MtPromiseResult>, expected_count: usize) -> bool {
    match promise {
        Some(promise) => {
            promise.outcome == MtPromiseOutcome::MtPromiseSuccess
                && promise
                    .unused_amounts
                    .as_ref()
                    .map_or(false, |amounts| amounts.len() == expected_count)
        }
        None => false,
    }
}

fn mt_requested_refund(
    request: &MtResolveRequest,
    promise: &MtPromiseResult,
    index: usize,
) -> MtU128 {
    let items = request.items.unwrap_or(&[]);
    let sent = items[index].transferred_amount;

    /* Failed/malformed callback results revert the full transfer. */
    if !mt_promise_result_is_valid(Some(promise), request.item_count()) {
        return sent;
    }

    /* Clamp hostile or out-of-range receiver values to the original transfer. */
    match promise.unused_amounts.as_deref() {
        Some(amounts) => mt_u128_min(amounts[index], sent),
        None => sent,
    }
}

fn mt_find_working_balance(balances: &[MtWorkingBalance], token_id: &str) -> usize {
    for (i, balance) in balances.iter().enumerate() {
        if balance.token_id == token_id {
            return i;
        }
    }

    balances.len()
}

/* Allocates an empty vector with the requested capacity, reporting allocation
 * failure instead of aborting, to mirror the C calloc NULL checks. */
fn mt_try_vec<T>(count: usize) -> Option<Vec<T>> {
    let mut buffer: Vec<T> = Vec::new();
    buffer.try_reserve_exact(count).ok()?;
    Some(buffer)
}

fn mt_validate_resolve_request(
    runtime: Option<&dyn MtResolveRuntime>,
    request: Option<&MtResolveRequest>,
) -> MtResolveResult {
    let request = match request {
        Some(request) if mt_runtime_is_complete(runtime) => request,
        _ => {
            return mt_resolve_result(
                MtResolveStatus::MtResolveInvalidRuntime,
                "Missing runtime operation or request.",
            );
        }
    };

    let items = request.items.unwrap_or(&[]);
    if !mt_is_nonempty(request.sender_id)
        || !mt_is_nonempty(request.receiver_id)
        || items.is_empty()
    {
        return mt_resolve_result(
            MtResolveStatus::MtResolveInvalidArgument,
            "Sender, receiver, and at least one transfer item are required.",
        );
    }

    for item in items {
        let snapshot = &item.approvals;

        if !mt_is_nonempty(item.token_id) {
            return mt_resolve_result(
                MtResolveStatus::MtResolveInvalidArgument,
                "Every transfer item must have a token ID.",
            );
        }

        if item.original_owner_id.is_some() && !mt_is_nonempty(item.original_owner_id) {
            return mt_resolve_result(
                MtResolveStatus::MtResolveInvalidArgument,
                "Original owner IDs must be non-empty when provided.",
            );
        }

        /* The C check "entry_count > 0 && entries == NULL" cannot occur here:
         * a slice carries its own length, so a missing list is always None
         * with zero entries. */
        let entries = snapshot.entries.unwrap_or(&[]);
        for entry in entries {
            if !mt_is_nonempty(entry.owner_id) {
                return mt_resolve_result(
                    MtResolveStatus::MtResolveInvalidArgument,
                    "An approval snapshot has an invalid owner ID.",
                );
            }
        }
    }

    mt_resolve_result(MtResolveStatus::MtResolveOk, "OK")
}

/*
 * Readable application-level resolver entry point.
 *
 * The caller supplies the original transfer amounts and approval snapshots
 * preserved by mt_transfer_call/mt_batch_transfer_call. The runtime adapter
 * supplies the promise result and performs the final state update atomically.
 */
pub fn mt_resolve_transfer(
    runtime: Option<&mut dyn MtResolveRuntime>,
    request: Option<&MtResolveRequest>,
    spent_amounts_out: Option<&mut [MtU128]>,
) -> MtResolveResult {
    let validation = mt_validate_resolve_request(runtime.as_deref(), request);
    if validation.status != MtResolveStatus::MtResolveOk {
        return validation;
    }

    /* Both values are present once validation has passed. */
    let (Some(runtime), Some(request)) = (runtime, request) else {
        return validation;
    };

    let item_count = request.item_count();

    /* The C capacity argument is the length of the output slice. */
    let spent_out = match spent_amounts_out {
        Some(buffer) if buffer.len() >= item_count => buffer,
        _ => {
            return mt_resolve_result(
                MtResolveStatus::MtResolveInvalidArgument,
                "The output buffer must hold one spent amount per item.",
            );
        }
    };

    let predecessor = runtime.predecessor_account_id();
    let current_account = runtime.current_account_id();
    let is_self_call = mt_is_nonempty(predecessor.as_deref())
        && mt_is_nonempty(current_account.as_deref())
        && predecessor == current_account;
    if !is_self_call {
        return mt_resolve_result(
            MtResolveStatus::MtResolveNotSelfCall,
            "mt_resolve_transfer may only be called by this contract itself.",
        );
    }

    let mut promise = MtPromiseResult {
        outcome: MtPromiseOutcome::MtPromiseFailed,
        unused_amounts: None,
    };
    let status = runtime.read_receiver_result(&mut promise);
    if status != MtResolveStatus::MtResolveOk {
        /* If the host cannot read the callback result, fail safely by asking
         * the resolver to return all transferred tokens. */
        promise.outcome = MtPromiseOutcome::MtPromiseFailed;
        promise.unused_amounts = None;
    }

    let (Some(mut working_balances), Some(mut refund_amounts), Some(mut spent_amounts)) = (
        mt_try_vec::<MtWorkingBalance>(item_count),
        mt_try_vec::<MtU128>(item_count),
        mt_try_vec::<MtU128>(item_count),
    ) else {
        return mt_resolve_result(
            MtResolveStatus::MtResolveOutOfMemory,
            "Could not allocate resolver working buffers.",
        );
    };
    /* Zero-initialize the amount buffers, as calloc did in C. */
    refund_amounts.resize(item_count, mt_u128_zero());
    spent_amounts.resize(item_count, mt_u128_zero());

    let items = request.items.unwrap_or(&[]);
    let receiver_id = request.receiver_id.unwrap_or("");

    /* Calculate refunds. A repeated token_id reuses the same working balance,
     * so the resolver never plans to refund more than that token's available
     * receiver balance across multiple entries. */
    for i in 0..item_count {
        let item = &items[i];
        /* Validation guarantees token_id is present and non-empty. */
        let token_id = item.token_id.unwrap_or("");
        let found_index = mt_find_working_balance(&working_balances, token_id);
        let requested_refund = mt_requested_refund(request, &promise, i);

        let balance_index = if found_index == working_balances.len() {
            let mut receiver_balance = mt_u128_zero();
            let status = runtime.balance_of(receiver_id, token_id, &mut receiver_balance);
            if status != MtResolveStatus::MtResolveOk {
                return mt_resolve_result(
                    MtResolveStatus::MtResolveBalanceReadFailed,
                    "Could not read the receiver's current token balance.",
                );
            }

            working_balances.push(MtWorkingBalance {
                token_id,
                remaining_balance: receiver_balance,
            });
            working_balances.len() - 1
        } else {
            found_index
        };

        let actual_refund = mt_u128_min(
            requested_refund,
            working_balances[balance_index].remaining_balance,
        );
        working_balances[balance_index].remaining_balance = mt_u128_subtract(
            working_balances[balance_index].remaining_balance,
            actual_refund,
        );

        refund_amounts[i] = actual_refund;
        spent_amounts[i] = mt_u128_subtract(item.transferred_amount, actual_refund);
    }

    /* Single atomic adapter call: move actual_refund from receiver to the
     * original owner, restore any applicable approval snapshot, and emit event
     * records. The adapter must roll back the transaction if it fails. */
    let status = runtime.apply_resolution(request, &refund_amounts, &spent_amounts);

    if status != MtResolveStatus::MtResolveOk {
        return mt_resolve_result(
            MtResolveStatus::MtResolveApplyFailed,
            "The runtime could not atomically apply the transfer resolution.",
        );
    }

    for (out, spent) in spent_out.iter_mut().zip(spent_amounts.iter()) {
        *out = *spent;
    }

    mt_resolve_result(
        MtResolveStatus::MtResolveOk,
        "Transfer resolved; output amounts report what the receiver actually spent.",
    )
}

pub fn mt_resolve_status_string(status: MtResolveStatus) -> &'static str {
    match status {
        MtResolveStatus::MtResolveOk => "ok",
        MtResolveStatus::MtResolveInvalidArgument => "invalid argument",
        MtResolveStatus::MtResolveInvalidRuntime => "invalid runtime",
        MtResolveStatus::MtResolveNotSelfCall => "resolver call is not from self",
        MtResolveStatus::MtResolvePromiseReadFailed => "promise result read failed",
        MtResolveStatus::MtResolveBalanceReadFailed => "receiver balance read failed",
        MtResolveStatus::MtResolveApplyFailed => "atomic resolution failed",
        MtResolveStatus::MtResolveOutOfMemory => "out of memory",
    }
}

/* Demonstration runtime: a deterministic in-memory adapter so the program runs
 * standalone. The receiver balance is fixed for every token. */
struct MockRuntime {
    predecessor: String,
    current: String,
    promise: MtPromiseResult,
    receiver_balance: MtU128,
}

impl MtResolveRuntime for MockRuntime {
    fn predecessor_account_id(&self) -> Option<String> {
        Some(self.predecessor.clone())
    }

    fn current_account_id(&self) -> Option<String> {
        Some(self.current.clone())
    }

    fn read_receiver_result(&mut self, result_out: &mut MtPromiseResult) -> MtResolveStatus {
        *result_out = self.promise.clone();
        MtResolveStatus::MtResolveOk
    }

    fn balance_of(
        &mut self,
        _account_id: &str,
        _token_id: &str,
        balance_out: &mut MtU128,
    ) -> MtResolveStatus {
        *balance_out = self.receiver_balance;
        MtResolveStatus::MtResolveOk
    }

    fn apply_resolution(
        &mut self,
        request: &MtResolveRequest,
        refund_amounts: &[MtU128],
        spent_amounts: &[MtU128],
    ) -> MtResolveStatus {
        for (i, item) in request.items.unwrap_or(&[]).iter().enumerate() {
            println!(
                "apply: token={:?} refund={} spent={}",
                item.token_id, refund_amounts[i].low, spent_amounts[i].low
            );
        }
        MtResolveStatus::MtResolveOk
    }
}

fn main() {
    let items = [
        MtResolveItem {
            token_id: Some("ft-a"),
            transferred_amount: mt_u128_from_low(100),
            original_owner_id: Some("alice"),
            approvals: MtApprovalSnapshot { entries: None },
        },
        MtResolveItem {
            token_id: Some("ft-a"),
            transferred_amount: mt_u128_from_low(50),
            original_owner_id: Some("alice"),
            approvals: MtApprovalSnapshot { entries: None },
        },
    ];

    let request = MtResolveRequest {
        sender_id: Some("alice"),
        receiver_id: Some("bob"),
        items: Some(&items[..]),
    };

    let mut runtime = MockRuntime {
        predecessor: "ledger.test".to_string(),
        current: "ledger.test".to_string(),
        promise: MtPromiseResult {
            outcome: MtPromiseOutcome::MtPromiseSuccess,
            unused_amounts: Some(vec![mt_u128_from_low(30), mt_u128_from_low(50)]),
        },
        receiver_balance: mt_u128_from_low(60),
    };

    let mut spent = vec![mt_u128_zero(); 2];

    let result = mt_resolve_transfer(
        Some(&mut runtime as &mut dyn MtResolveRuntime),
        Some(&request),
        Some(&mut spent[..]),
    );

    println!("status: {}", mt_resolve_status_string(result.status));
    println!("message: {}", result.message);
    for (i, amount) in spent.iter().enumerate() {
        println!("spent[{}] = high={} low={}", i, amount.high, amount.low);
    }
}
