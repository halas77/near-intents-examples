use std::any::Any;

const MT_ONE_YOCTO_DEPOSIT: u64 = 1;

/* Conservative limit to keep batch execution bounded. Tune to the target
 * runtime's gas and storage budget; this is an application policy, not a C rule.
 */
const MT_MAX_BATCH_ITEMS: usize = 100;

#[allow(dead_code)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MtStatus {
    Ok = 0,
    InvalidArgument,
    InvalidRuntime,
    InvalidDeposit,
    InvalidSender,
    InvalidReceiver,
    InvalidTokenId,
    InvalidAmount,
    InvalidApproval,
    BatchTooLarge,
    PrepareFailed,
    ExecutionFailed,
}

#[derive(Debug, Clone, Copy)]
pub struct MtBatchItem<'a> {
    pub token_id: Option<&'a str>,
    /* Amounts are decimal strings to preserve the NEP-245 u128 JSON format. */
    pub amount: Option<&'a str>,

    /* Equivalent to one entry in the optional approvals array. */
    pub has_approval: bool,
    pub approval_owner_id: Option<&'a str>,
    pub approval_id: u64,
}

#[derive(Debug, Clone, Copy)]
pub struct MtBatchTransferCall<'a> {
    pub receiver_id: Option<&'a str>,
    pub items: Option<&'a [MtBatchItem<'a>]>,
    pub memo: Option<&'a str>, /* Optional; None means absent. */
    pub msg: Option<&'a str>,  /* Required string; an empty string is valid. */
}

/* Opaque prepared plan owned by the platform adapter. */
pub type MtPlan = Box<dyn Any>;

/* Runtime adapter. The C function-pointer table and its opaque context
 * pointer are represented by the implementor of this trait (self). */
pub trait MtRuntimeOps {
    /* Read the NEAR-like execution context. */
    fn predecessor_account_id(&mut self) -> Option<String>;
    fn attached_deposit_yocto(&mut self) -> u64;

    /* Use the target chain's actual account/token validation rules. */
    fn is_valid_account_id(&mut self, account_id: &str) -> bool;
    fn is_valid_token_id(&mut self, token_id: &str) -> bool;

    /* Platform-specific operations. See file header for required semantics. */
    fn prepare_batch(
        &mut self,
        sender_id: &str,
        receiver_id: &str,
        items: &[MtBatchItem<'_>],
        plan_out: &mut Option<MtPlan>,
    ) -> MtStatus;

    fn commit_and_schedule(
        &mut self,
        prepared_plan: &MtPlan,
        sender_id: &str,
        receiver_id: &str,
        items: &[MtBatchItem<'_>],
        memo: Option<&str>,
        msg: &str,
    ) -> MtStatus;

    fn destroy_plan(&mut self, prepared_plan: MtPlan);
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MtResult {
    pub status: MtStatus,
    /* Static diagnostic text; not dynamically allocated. */
    pub message: &'static str,
}

fn mt_result(status: MtStatus, message: &'static str) -> MtResult {
    MtResult { status, message }
}

fn mt_is_nonempty(text: Option<&str>) -> bool {
    matches!(text, Some(t) if !t.is_empty())
}

/* Check decimal syntax here. The runtime adapter must additionally parse the
 * value using the contract's full u128 implementation and enforce its range.
 */
fn mt_is_decimal_amount(amount: Option<&str>) -> bool {
    match amount {
        Some(s) if !s.is_empty() => s.bytes().all(|b| b.is_ascii_digit()),
        _ => false,
    }
}

/* Presence of the runtime is the only check left: the trait guarantees every
 * operation exists. */
fn mt_runtime_is_complete(runtime: Option<&dyn MtRuntimeOps>) -> bool {
    runtime.is_some()
}

fn mt_validate_request(
    runtime: Option<&mut dyn MtRuntimeOps>,
    request: Option<&MtBatchTransferCall<'_>>,
    sender_id_out: &mut Option<String>,
) -> MtResult {
    let complete = mt_runtime_is_complete(runtime.as_deref());
    let (rt, request) = match (runtime, request) {
        (Some(rt), Some(request)) if complete => (rt, request),
        _ => {
            return mt_result(
                MtStatus::InvalidArgument,
                "Missing runtime operations or request fields.",
            )
        }
    };

    let items: &[MtBatchItem<'_>] = request.items.unwrap_or(&[]);
    if !mt_is_nonempty(request.receiver_id) || request.msg.is_none() || items.is_empty() {
        return mt_result(
            MtStatus::InvalidArgument,
            "Receiver, message, and a non-empty batch are required.",
        );
    }

    if items.len() > MT_MAX_BATCH_ITEMS {
        return mt_result(MtStatus::BatchTooLarge, "Batch exceeds MT_MAX_BATCH_ITEMS.");
    }

    if rt.attached_deposit_yocto() != MT_ONE_YOCTO_DEPOSIT {
        return mt_result(
            MtStatus::InvalidDeposit,
            "Exactly one yocto must be attached.",
        );
    }

    let sender_id = match rt.predecessor_account_id() {
        Some(sender)
            if mt_is_nonempty(Some(sender.as_str())) && rt.is_valid_account_id(&sender) =>
        {
            sender
        }
        _ => return mt_result(MtStatus::InvalidSender, "Caller account ID is invalid."),
    };

    let receiver_id = request.receiver_id.unwrap_or("");
    if !rt.is_valid_account_id(receiver_id) {
        return mt_result(MtStatus::InvalidReceiver, "Receiver account ID is invalid.");
    }

    for item in items {
        let token_ok = match item.token_id {
            Some(token) => !token.is_empty() && rt.is_valid_token_id(token),
            None => false,
        };
        if !token_ok {
            return mt_result(MtStatus::InvalidTokenId, "A token ID is invalid.");
        }

        if !mt_is_decimal_amount(item.amount) {
            return mt_result(
                MtStatus::InvalidAmount,
                "Amounts must be unsigned decimal strings.",
            );
        }

        if item.has_approval {
            let owner_ok = match item.approval_owner_id {
                Some(owner) => !owner.is_empty() && rt.is_valid_account_id(owner),
                None => false,
            };
            if !owner_ok {
                return mt_result(
                    MtStatus::InvalidApproval,
                    "An approval owner account ID is invalid.",
                );
            }
        }
    }

    *sender_id_out = Some(sender_id);
    mt_result(MtStatus::Ok, "OK")
}

/*
 * Readable application-level entry point.
 *
 * It validates the request, asks the platform adapter to prepare the entire
 * batch without changing state, then asks the adapter to commit the transfer
 * and schedule the receiver/resolver chain atomically.
 */
pub fn mt_batch_transfer_call(
    runtime: Option<&mut dyn MtRuntimeOps>,
    request: Option<&MtBatchTransferCall<'_>>,
) -> MtResult {
    let mut sender_id: Option<String> = None;

    let validation = mt_validate_request(runtime.as_deref_mut(), request, &mut sender_id);
    if validation.status != MtStatus::Ok {
        return validation;
    }

    let (Some(rt), Some(request), Some(sender_id)) = (runtime, request, sender_id) else {
        /* Unreachable after successful validation; kept as a defensive guard. */
        return mt_result(
            MtStatus::InvalidArgument,
            "Missing runtime operations or request fields.",
        );
    };

    let receiver_id = request.receiver_id.unwrap_or("");
    let items: &[MtBatchItem<'_>] = request.items.unwrap_or(&[]);
    let msg = request.msg.unwrap_or("");

    let mut prepared_plan: Option<MtPlan> = None;
    let status = rt.prepare_batch(&sender_id, receiver_id, items, &mut prepared_plan);

    let plan: MtPlan = match prepared_plan {
        Some(plan) if status == MtStatus::Ok => plan,
        other => {
            if let Some(stale) = other {
                rt.destroy_plan(stale);
            }
            return mt_result(
                MtStatus::PrepareFailed,
                "Batch authorization or balance preparation failed.",
            );
        }
    };

    let status = rt.commit_and_schedule(&plan, &sender_id, receiver_id, items, request.memo, msg);

    rt.destroy_plan(plan);

    if status != MtStatus::Ok {
        return mt_result(
            MtStatus::ExecutionFailed,
            "Atomic transfer/callback scheduling failed.",
        );
    }

    mt_result(
        MtStatus::Ok,
        "Transfer committed and receiver/resolver scheduled.",
    )
}

pub fn mt_status_string(status: MtStatus) -> &'static str {
    match status {
        MtStatus::Ok => "ok",
        MtStatus::InvalidArgument => "invalid argument",
        MtStatus::InvalidRuntime => "invalid runtime",
        MtStatus::InvalidDeposit => "invalid attached deposit",
        MtStatus::InvalidSender => "invalid sender",
        MtStatus::InvalidReceiver => "invalid receiver",
        MtStatus::InvalidTokenId => "invalid token ID",
        MtStatus::InvalidAmount => "invalid amount",
        MtStatus::InvalidApproval => "invalid approval",
        MtStatus::BatchTooLarge => "batch too large",
        MtStatus::PrepareFailed => "batch preparation failed",
        MtStatus::ExecutionFailed => "execution failed",
    }
}

/* Demonstration runtime. Stands in for the platform adapter so the program
 * runs stand-alone; it is not part of the original C contract. */
struct MockRuntime {
    deposit: u64,
    predecessor: Option<String>,
    commits: usize,
}

impl MtRuntimeOps for MockRuntime {
    fn predecessor_account_id(&mut self) -> Option<String> {
        self.predecessor.clone()
    }

    fn attached_deposit_yocto(&mut self) -> u64 {
        self.deposit
    }

    fn is_valid_account_id(&mut self, account_id: &str) -> bool {
        !account_id.is_empty() && !account_id.contains(' ')
    }

    fn is_valid_token_id(&mut self, token_id: &str) -> bool {
        !token_id.is_empty()
    }

    fn prepare_batch(
        &mut self,
        _sender_id: &str,
        _receiver_id: &str,
        items: &[MtBatchItem<'_>],
        plan_out: &mut Option<MtPlan>,
    ) -> MtStatus {
        *plan_out = Some(Box::new(items.len()));
        MtStatus::Ok
    }

    fn commit_and_schedule(
        &mut self,
        prepared_plan: &MtPlan,
        sender_id: &str,
        receiver_id: &str,
        items: &[MtBatchItem<'_>],
        memo: Option<&str>,
        msg: &str,
    ) -> MtStatus {
        let planned = prepared_plan.downcast_ref::<usize>().copied().unwrap_or(0);
        println!(
            "commit: sender={} receiver={} items={} planned={} memo={:?} msg={:?}",
            sender_id,
            receiver_id,
            items.len(),
            planned,
            memo,
            msg
        );
        self.commits += 1;
        MtStatus::Ok
    }

    fn destroy_plan(&mut self, _prepared_plan: MtPlan) {}
}

fn main() {
    let item_a = MtBatchItem {
        token_id: Some("token-a"),
        amount: Some("100"),
        has_approval: false,
        approval_owner_id: None,
        approval_id: 0,
    };
    let item_b = MtBatchItem {
        token_id: Some("token-b"),
        amount: Some("250"),
        has_approval: true,
        approval_owner_id: Some("alice.near"),
        approval_id: 7,
    };
    let items = [item_a, item_b];
    let request = MtBatchTransferCall {
        receiver_id: Some("receiver.near"),
        items: Some(&items),
        memo: Some("test"),
        msg: Some("{}"),
    };

    let mut runtime = MockRuntime {
        deposit: 1,
        predecessor: Some("sender.near".to_string()),
        commits: 0,
    };

    /* Valid request. */
    let result =
        mt_batch_transfer_call(Some(&mut runtime as &mut dyn MtRuntimeOps), Some(&request));
    println!(
        "result: {:?} - {} ({})",
        result.status,
        result.message,
        mt_status_string(result.status)
    );

    /* Wrong attached deposit. */
    runtime.deposit = 2;
    let result =
        mt_batch_transfer_call(Some(&mut runtime as &mut dyn MtRuntimeOps), Some(&request));
    println!(
        "result: {:?} - {} ({})",
        result.status,
        result.message,
        mt_status_string(result.status)
    );

    /* Invalid amount in a batch item. */
    runtime.deposit = 1;
    let bad_item = MtBatchItem {
        token_id: Some("token-c"),
        amount: Some("1a"),
        has_approval: false,
        approval_owner_id: None,
        approval_id: 0,
    };
    let bad_items = [bad_item];
    let bad_request = MtBatchTransferCall {
        receiver_id: Some("receiver.near"),
        items: Some(&bad_items),
        memo: None,
        msg: Some(""),
    };
    let result = mt_batch_transfer_call(
        Some(&mut runtime as &mut dyn MtRuntimeOps),
        Some(&bad_request),
    );
    println!(
        "result: {:?} - {} ({})",
        result.status,
        result.message,
        mt_status_string(result.status)
    );

    println!("successful commits: {}", runtime.commits);
}
