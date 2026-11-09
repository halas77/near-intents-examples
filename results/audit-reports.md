
find and extract all findings for near intent, hot multi token contract and hot bridge, i just want all finding for this protocols and also the if they are resolved or not and how they resolved
Security findings: NEAR Intents, HOT Multi Token, and HOT Bridge
I’m treating these as three related but distinct security scopes:

Scope

Contract / project

NEAR Intents

intents.near — NEAR Intents Verifier / Defuse

HOT Multi Token

v2_1.omni.hot.tg — NEP-245 multi-token ledger

HOT Bridge

bridge-refuel.hot.tg and the HOT Omni Bridge infrastructure

One particularly important discovery is a September 30, 2026 HOT Bridge exploit, which directly involved the interaction between HOT's multi-token contract and NEAR Intents. It is not merely an audit finding: it was an exploited vulnerability, with approximately $3.86 million in observed BNB Chain treasury payouts. 

CertiK
+1

I’ll distinguish between:

Audit findings: vulnerabilities identified during security reviews.

Disclosed vulnerabilities: issues reported through security disclosures or bug bounties.

Exploited vulnerabilities: issues demonstrated in real transactions.

Remediation status: fixed, mitigated, accepted, unresolved, or not publicly verifiable.

An issue being marked resolved in an audit is not, by itself, proof that the deployed contract contains the fix.

1. NEAR Intents — confirmed audit findings
Audit A: Hacken — January 27, 2025
5 findings 2 fixed 2 accepted

Auditor: Hacken
Repository: near/intents
Audited language: Rust
Reviewed commits:

160ba5829fea636283375ec462042d51409a6e66

91fee5e119fd74d8de1dbb57d27060873a0ae503

The audit reports five findings, four medium and one low. 

hacken.io
+1

ID

Finding

Severity

Audit status

F-2025-8343

Lack of Full Access Key Verification for Fee Update

Medium

Fixed

F-2025-8345

Native Balance Exhausting due to Unpaid Storage Increase

Medium

Accepted

F-2025-8338

Profitable Intents Interception due to Front Running

Medium

Mitigated

F-2025-8337

Inability to Execute Swap due to Fee Calculation Mechanism

Medium

Fixed

F-2025-8339

Lack of Signed Payload Versioning

Low

Accepted


hacken.io
+1
Important limitation: Hacken's public finding index provides the titles and statuses, but its individual finding details are not exposed in the indexed page. I won't invent the precise vulnerable functions, code paths, or claimed patches. The audit also lists three additional potential risks, which I cover separately below.

Audit B: Guvenkaya — NEAR Intents Security Review
Medium finding identified
Finding:

Potential Funds Stealing From Users Via Repeating Failed Intents

This is a separate published audit issue, not one of the five Hacken findings.

The Guvenkaya public report archive identifies the finding as a medium-severity NEAR Intents issue. 

GitHub
+1

I am treating its detailed remediation status as unverified until the underlying report and subsequent code changes are checked.

Audit C: Guvenkaya — NEAR Intents Passkeys Pull Request Security Review
A separate review exists for the Passkeys pull request. It must be tracked as its own review rather than assumed to be a second audit of the complete production Verifier.

I have confirmed its publication in the Guvenkaya report archive, but have not yet established a separate finding count. 

GitHub
+1

2. September 30, 2026 — HOT Bridge / NEAR Intents exploit
Exploited — approximately $3.865 million
This is the most important issue in the research because it demonstrates a real cross-contract accounting failure.

Affected components

intents.near: internal balance ledger.

v2_1.omni.hot.tg: HOT's NEP-245 Multi Token representation ledger.

HOT's BNB Chain treasury: underlying USDT backing.

Malicious receiver: attacker-controlled notification callback.

The attack exploited the interaction between these systems, rather than simply compromising one token-transfer function. 

CertiK
+2

Root cause
The vulnerable refund calculation was effectively:

let requested_refund = requested_refund.unwrap_or(*deposited);
let balance_left = receiver.token_balances.amount_for(&token_id);
let refund_amount = balance_left.min(requested_refund);

It applied two restrictions:

The requested refund.

The receiver's available internal token balance.

But it omitted a third restriction:

3. The actual amount deposited in the current transfer.

Consequently, an attacker could use an existing internal balance to request a refund much larger than the new transfer. 

CertiK
+1

Exploitation sequence
Step

Operation

Result

1

Attacker prefunds a malicious receiver with filler tokens

Existing internal balance established

2

Attacker invokes HOT mt_batch_transfer_call()

97 filler entries plus USDT

3

Intents executes mt_on_transfer()

Internal credit is created

4

Malicious receiver returns oversized refunds

97 requests of 1e36 raw units

5

Intents executes mt_resolve_deposit()

Refund event exceeds the log-size limit

6

Refund callback fails

Its accounting changes roll back

7

HOT executes mt_resolve_transfer()

Original transferred assets are returned

8

Earlier Intents deposit credit survives

Internal credit is now unbacked

The decisive detail is the separation of asynchronous NEAR receipts. The earlier deposit receipt succeeded, but the later refund-resolution receipt failed. Failure of the latter did not automatically undo the former. 

CertiK
+2

Why the oversized event mattered
The malicious receiver used 97 filler-token entries, each requesting a refund of 1e36 raw units.

The resulting serialized MtBurnEvent was 16,495 bytes, exceeding NEAR's 16,384-byte log limit.

This made event serialization an exploitable part of the accounting failure, rather than merely a logging inconvenience. 

blocksec.com
+1

Remediation and recovery
Core refund bug fixed
The project deployed the following calculation on October 2, 2026:

let refund_amount = requested_refund
    .min(*deposited)
    .min(balance_left);

This introduces the missing current-deposit ceiling.

Further actions:

Date

Remediation

Status

October 2, 2026

Refund amount capped by current deposit

Fixed

October 2, 2026

NEAR Intents upgrade to release 0.4.4

On-chain upgrade observed

October 7, 2026

Deposit notifications removed

Reported deployed

After incident

Internal balances compared against actual token holdings; divergence triggers automatic pause

Reported implemented

October 2, 2026

Project announced return of funds

Recovery announced

The notification removal is particularly important: it closes the vulnerable receiver-controlled refund path, rather than relying exclusively on the corrected calculation.

BlockSec reports that all affected users were made whole. CertiK also records the post-incident upgrade. 

blocksec.com
+1

My assessment: The original exploit path is reported as fixed, with multiple layers of remediation. The refund cap is the primary logic fix; removing deposit notifications is an additional architectural safeguard. I would not treat the incident as proof that every HOT Bridge or Multi Token issue is resolved.

Audit D: Guvenkaya — detailed findings register
Review period: February 12 – March 5, 2025 · Reviewed baseline: 6da9e2b3ab598f277d45fb356aee01a5d80ac0a6

1 scheduled 3 not fixed in final report

Guvenkaya explicitly reports that the team had not fixed the four issues at the end of this engagement. 

Guvenkaya
+1

GUV-1 — Potential Funds Stealing From Users Via Repeating Failed Intents

Medium · Scheduled
This is worth investigating closely, especially for intent replay and nonce-handling research.

The auditor identified an attack in which a user can deliberately make an intent transaction fail and subsequently repeat selected intents.

The failure can be induced by:

Invalidating the nonce after signing, through a separate transaction.

Adding another intent that transfers funds out and causes the overall TokenDiff validation to fail.

An attacker can then reconstruct selected intents from failed on-chain transactions while their deadlines remain valid.

The problem is particularly serious for P2P transfers that do not use TokenDiff. 

Guvenkaya
+1

Recommended remediation: Prefer TokenDiff for swaps, discourage Transfer for swap execution, and document the risk to users who sign transactions.

Recorded remediation: The team acknowledged the issue and scheduled documentation as the fix. This is weaker than a demonstrated contract-level patch.

My assessment: I would not classify this as fully fixed without verifying nonce consumption, intent replay protection, and transaction atomicity in the current implementation.

GUV-2 — Possible DoS of Public Keys Viewing Per User

Low · Not fixed in report
Affected function:

public_keys_of(account_id)

Affected file:

defuse/src/contract/accounts/mod.rs
The problem is that users can have unlimited public keys. The method iterates over all keys belonging to an account and collects them into a HashSet.

A malicious user could accumulate enough keys that reading them consumes more gas than the transaction allows.

Potential effects:

Off-chain components using public_keys_of may fail.

Other contract functionality that iterates over the same keys may become unavailable, depending on its execution path.

Recommended remediation: Enforce an upper bound on the number of public keys per account.

Recorded status: Not fixed. 

Guvenkaya
+1

GUV-3 — Arbitrary Public Key Setting in Privileged Functions

Informational · Not fixed in report
The auditor identified insufficient validation of public keys in several places.

Affected functions include:

add_public_key
remove_public_key

do_add_relayer_key
delete_relayer_key

add_full_access_key
delete_key
The report highlights that the NEAR SDK PublicKey type does not provide comprehensive validation of all public-key formats and values.

Potential consequences include invalid or malformed keys reaching cryptographic operations, undefined behavior, or weak-key injection that could contribute to signature malleability.

Recommended remediation: Explicitly validate keys in all relevant account, relayer-key, and full-access-key management operations.

Recorded status: Not fixed. 

Guvenkaya
+1

GUV-4 — Missing Event Emission for Critical Access Control Operations

Informational · Not fixed in report
Affected functions:

delete_relayer_key()
do_add_relayer_key()

The problem is not necessarily unauthorized access. It is the lack of emitted events when relayer keys are added or removed.

Without these events, off-chain monitoring and auditing systems cannot reliably reconstruct important changes in relayer authorization.

Recommended remediation: Emit events for both relayer-key addition and removal.

Recorded status: Not fixed. 

Guvenkaya
+1

Official report: NEAR Intents — Guvenkaya Security Review.

Why the Guvenkaya findings matter for Rust research
Three particularly interesting implementation patterns emerge:

Unbounded collection iteration: a valid account state can make a read operation exceed the gas budget.

Public-key type validation: parsing or representing a key is not necessarily equivalent to validating that it is safe for cryptographic use.

Failed transaction replay: transaction failure and state/nonce handling can interact in ways that permit previously signed actions to be reconstructed.

These are separate from the September 2026 refund exploit. They should not be conflated into one root cause.

3. NEAR Intents audit — additional potential risks
Hacken also documented three architectural risks that are not included in its five formal findings:

Risk

What can happen

Reported treatment

Unpaid storage allocation

Users can increase contract storage without paying, potentially exhausting native NEAR reserves

Acknowledged

DAO centralization

DAO permissions include upgrades, unrestricted withdrawals, and key management

Architectural risk

Callback failure

Abnormal gas consumption by external token contracts can cause withdrawal failures and locked funds

Simulation and sufficient gas recommended

Redundant JSON fields

Extra signed-payload fields can mislead users about the actions being authorized

Potential risk

These matter because they identify additional attack surfaces even though they are not formal findings with individual remediation statuses. 

hacken.io

4. HOT Bridge / HOT Multi Token — Veridise audit, September 1, 2025
21 findings 18 fixed 2 confirming fix 1 acknowledged only

This is the most directly relevant audit for v2_1.omni.hot.tg.

Auditor: Veridise
Engagement: July 16–30, 2025; final report September 1, 2025
Reviewed components: NEAR Bridge (Rust), Validation SDK (Rust), and Stellar Locker (Rust).
Reviewed commits: 356f6eb, 8729129, and 65520e7, respectively.

The NEAR Bridge scope explicitly includes NEP-245 core transfers, the transfer-call resolver, storage management, deposits, withdrawals, and withdrawal-proof verification. The HOT documentation identifies the NEAR OmniBalance contract as the multi-token ledger that represents assets locked on external chains. 

veridise.com
+1

Important correction: Veridise's web archive page displays zero findings, but the downloadable report PDF contains 21. I used the report's actual findings tables and descriptions, not the archive's incorrect zero count. 

veridise.com
+1

4.1 NEAR Bridge / NEP-245 Multi Token findings
12 findings · includes Critical, High, Medium, Low, Warning and Informational

Finding

Severity

Status in report

Root cause and reported resolution

V-HOTB-VUL-001 — Lack of access control in resolve function enables arbitrary token transfers

Critical

Fixed

mt_resolve_transfer() was externally callable. An attacker could construct a fake promise/callback context and attempt to trigger transfers from other users. Fix: mark the resolver #[private]. PR #14.

V-HOTB-VUL-002 — Bridge tokens can be minted to attacker due to mt_deposit_call() hash collision

High

Fixed

The receiver identifier was derived by hashing concatenated variable-length account and message bytes. Different input pairs could produce the same concatenated byte sequence. Fix: hash a structured/serialized representation of the deposit-call arguments, avoiding ambiguous concatenation; deposit handling was also changed to route funds through the bridge owner. PR #15.

V-HOTB-VUL-003 — Double spend attack due to missing nonce freshness check

High

Fixed

Old used nonces could be cleared after the retention period and then submitted again. Fix: change nonce storage/cleanup so stale used nonces cannot be reintroduced and nonces are only removed when sufficiently old. PR #21.

V-HOTB-VUL-004 — Griefing attack on user withdrawals due to missing access control checks

High

Fixed

Unrestricted changes to the public key used for nonce removal could let an attacker clear a pending withdrawal nonce before the legitimate MPC withdrawal completed. Fix: restrict set_public_key_for_nonce_removal() and remove_public_key_for_nonce_removal() to the owner. PR #18.

V-HOTB-VUL-005 — Withdrawal receiver unable to clean nonces themselves

High

Confirming Fix

The receiver could not independently clear a completed withdrawal nonce in some Stellar/TON paths. The sender therefore had to cooperate when sender and receiver differed. Recommendation: add the required signature verification support, including Stellar support in verify_against_user_public_key(). No confirmed implementation is identified in the report.

V-HOTB-VUL-006 — Million Small Deposits attack via storage_deposit()

Medium

Fixed

The contract paid the storage cost of creating account records, allowing attackers to create many tiny registrations and exhaust native NEAR reserves. Fix: require a minimum deposit covering the relevant storage allocation and correctly honor registration_only. PR #22.

V-HOTB-VUL-007 — Empty withdrawal requests can be used to block users

Medium

Fixed

Repeated empty/low-value withdrawal requests could fill a user's queue and delay legitimate withdrawals because pending requests required individual cleanup. Reported response: introduce batch nonce-cleaning operations and adjust withdrawal fees based on queue length. PR #24.

V-HOTB-VUL-008 — Bridge account vulnerable to unauthorized fund withdrawals via NEP-245 transfer call

Low

Fixed

A transfer-call with the bridge itself as receiver could enter withdrawal-related handling; the missing receiver callback caused resolver refund behavior to draw from the bridge's own token balance. Fix: reject the bridge's own account as the receiver in the relevant internal batch-transfer path. PR #25.

V-HOTB-VUL-009 — Non-compliance with NEP-145

Low

Fixed in summary table

registration_only was ignored and storage_unregister() was not implemented as required. The report associates the fix with the storage-management changes in PR #22. Caveat: the detailed report text contains a developer-response statement inconsistent with its summary status, so I would independently inspect the final implementation before treating every NEP-145 requirement as verified.

V-HOTB-VUL-010 — Unbounded token batch transfer may lead to token loss

Low

Fixed

An unbounded mt_batch_transfer_call() could consume enough gas in token decoding/processing that the resolver did not have enough gas to finish. Fix: cap the batch size at 100 tokens. PR #27.

V-HOTB-VUL-011 — Bridge init call front-running risk

Warning

Fixed

If deployment had not yet initialized the contract, an attacker could call the public constructor and become owner. Fix: make Contract::new() private to the contract's deployment/initialization context using #[private]. PR #23.

V-HOTB-VUL-012 — Minor Code Quality Issues

Informational

Fixed in summary table

Miscellaneous maintainability problems: unused items, naming/documentation issues, manual one-yoctoNEAR checks, and an unwrap on memo input that could panic. The report associates remediation with PR #29, but its detailed developer-response text is not fully consistent with the summary's fixed status.

Sources: Veridise's finding descriptions and fix references for the NEAR Bridge findings. 

veridise.com
+10

My technical priorities from this group: VUL-001, VUL-002, VUL-003, VUL-004, VUL-008 and VUL-010. These are the most directly connected to asset movement, refund handling, nonce freshness, and callback/resolver security.

4.2 HOT Validation SDK findings
These are not the on-chain Multi Token contract itself, but they matter because the SDK participates in validation and withdrawal-signature workflows.

Finding

Severity

Status in report

Root cause and reported resolution

V-HOTB-VUL-001 — SDK missing nonce cleaning signature generation

High

Confirming Fix

SDK could not generate the MPC signatures needed for the completed-withdrawal nonce-cleanup path. The receiver-cleanup limitation was especially relevant when the recipient differed from the sender. Developers acknowledged the problem and agreed to fix it, but the report does not confirm a completed fix.

V-HOTB-VUL-002 — Inaccurate criteria for signature generation can result in loss of funds

Medium

Fixed

MPC response handling could accept a threshold of positive responses without sufficiently requiring an honest majority, depending on response order. Fix: validate that the configured threshold is strictly more than half of the configured servers (len / 2 + 1 or equivalent). PR #4.

V-HOTB-VUL-003 — Servers collection allows duplicates

Low

Fixed

Duplicate server entries in a vector could give one server multiple votes in threshold logic. Fix: reject duplicate server addresses when deserializing/validating the configuration. PR #4.

V-HOTB-VUL-004 — Maintainability issues

Warning

Fixed in summary table

Issues included missing/uneven wallet ID and metadata validation, ignored metadata, incorrect documentation, test reliability, and a chain-ID inconsistency. Developers reported addressing most points; the report notes an outstanding test/RPC-rate-limit observation. PR 06ba9ce.

V-HOTB-VUL-005 — EVM verifier config is taken from Stellar entries by mistake

Warning

Fixed

The SDK's filter for non-NEAR configurations could accidentally include Stellar entries in the EVM configuration. Fix: explicitly select EVM chain configurations. PR #3.

Sources: Veridise's SDK findings, developer responses and fix references. 

veridise.com
+6

4.3 HOT Stellar Locker findings
These relate to the Stellar-side Rust component, not the NEAR Multi Token contract. They are nevertheless part of the same HOT Bridge security assessment.

Finding

Severity

Status in report

Root cause and reported resolution

V-HOTB-VUL-001 — Lack of domain separation between deposit and withdrawal messages allows invalidating arbitrary nonces

Medium

Acknowledged; no code fix

Deposit and withdrawal messages lacked an explicit message-type domain separator. A user-controlled deposit nonce could overlap with a withdrawal nonce, enabling a deposit signature to interfere with a legitimate withdrawal nonce. The report says the developers chose to rely on distinct deposit and withdrawal public keys rather than implementing the recommended code-level domain separation.

V-HOTB-VUL-002 — Change of owner does not use two-step pattern

Warning

Fixed

Ownership could be transferred immediately, creating a risk of accidental lockout. Fix: implement a two-step process in which the proposed new owner must accept ownership. Stellar PR #2.

V-HOTB-VUL-003 — Maintainability issues

Warning

Fixed in summary table

Included naming/documentation errors, redundant code, an unused field, confusion between a timestamp and a nonce, and concerns about a nonce-cleanup method. PR #1 is cited in the report.

V-HOTB-VUL-004 — Incorrect order of arguments when extending instance TTL

Warning

Fixed

increase_instant_ttl() passed the TTL threshold and extension values in the wrong order. Fix: swap the arguments to match the Soroban API's expected (threshold, extend_to) order. Stellar PR #1.

Sources: Veridise's Stellar Locker findings and remediation descriptions. 

veridise.com
+5

What remains open in the Veridise report?
As of the September 1, 2025 report:

Component

Finding

Reported status

NEAR Bridge

VUL-005: receiver cannot clean withdrawal nonce

Confirming Fix

Validation SDK

VUL-001: missing nonce-cleaning signature generation

Confirming Fix

Stellar Locker

VUL-001: missing domain separation

Acknowledged, not code-fixed

The last item is especially important: using different public keys is an operational mitigation, not the same as enforcing domain separation in the signed message. 

veridise.com
+2

5. HOT Omni Token — Hacken audit, October 9, 2024
11 findings 4 fixed 7 accepted

This is an additional HOT bridge audit that should be included in the wider HOT security history, but its scope is different from the NEAR Rust contract.

Repository: hot-dao/omni-wallet-solidity

Audited commit: 40ff89f

Language: Solidity

Networks: Ethereum, Base, Arbitrum, Polygon

Contracts: MetaWallet.sol, RlpEncode.sol

It is a multi-chain wallet/bridge that handles native-asset and ERC-20 deposits and withdrawals using signatures. It is not the v2_1.omni.hot.tg NEP-245 implementation. 

hacken.io
+1

All 11 findings
ID

Finding

Severity

Status

F-2024-6207

Precompile ecrecover May Lead to Signature Malleability

Medium

Fixed

F-2024-6228

Unchecked Return Value in Token Transfer May Lead to Unexpected Behavior

Low

Fixed

F-2024-6225

Lack of EIP-712 Compliance May Result in Signature Replay

Low

Accepted

F-2024-6222

Use of transfer() to Send Native Assets May Revert

Low

Fixed

F-2024-6262

Unused Code Should be Removed

Observation

Fixed

F-2024-6261

Missing Zero Address Checks

Observation

Accepted

F-2024-6260

Single-Step Owner Transfer May Cause DoS

Observation

Accepted

F-2024-6236

Missing Event Emission

Observation

Accepted

F-2024-6235

Unused Function Parameters

Observation

Accepted

F-2024-6223

Visibility of State Variable is Not Defined

Observation

Accepted

F-2024-6221*

Old Solidity Version May Result in Unsafe Code

Observation

Accepted

*The final finding is cross-matched from Hacken's code-quality reference to the indexed finding title. The indexed report page exposes the first ten rows, while the independent audit index identifies the eleventh title. 

hacken.io
+1

Root causes and remediation meaning
Fixed findings

6207 — Signature malleability: ecrecover can accept non-canonical signature representations. The audit marks this fixed. The indexed report does not expose the precise final patch, so I cannot verify whether the implementation adopted an ECDSA library or explicit low-s validation.

6228 — Unchecked token-transfer return value: a token call may return false without reverting. If the caller ignores that return value, it can treat a failed transfer as successful. Marked fixed; the exact patch is not exposed in the indexed report.

6222 — Native transfer() can revert: Solidity's stipend-limited native transfer can fail for recipients needing more gas. Marked fixed; the exact replacement implementation is not exposed.

6262 — Unused code: dead or unnecessary code was identified and marked removed.

Accepted findings

6225 — EIP-712 signature replay: signatures did not follow the EIP-712 typed-data domain-separation standard. This creates replay-protection concerns across contexts such as chains or contracts. Accepted, not reported as fixed.

6261 — Missing zero-address checks: address parameters or configuration could be set to zero, potentially disabling functionality or making funds inaccessible. Accepted.

6260 — Single-step ownership transfer: ownership can be transferred to an incorrect address without an acceptance step. This can permanently lock out the intended administrator. Accepted.

6236 — Missing event emission: important state changes lack events needed by monitoring and indexers. Accepted.

6235 — Unused function parameters: parameters remain in function interfaces despite not being used. Accepted.

6223 — State-variable visibility not explicitly defined: visibility should be deliberately specified to make access and interface behavior clear. Accepted.

6221 — Old Solidity version may result in unsafe code: compiler-version choice may leave the implementation exposed to old compiler behavior, bugs, or incompatibility with supported chains. Accepted.

The key distinction is that accepted is not the same as fixed. Hacken's report gives four resolved and seven accepted, with zero mitigated. For the four fixed findings, the public indexed page gives the status but not enough detail to substantiate the exact patch for each one. 

hacken.io
+1

Additional risks that Hacken did not count as formal findings
The report separately identifies six design and operational concerns:

Deposit nonces are generated on-chain, but withdrawal nonces are generated off-chain. The division by NONCE_TS_SHIFT can create zero or unintended nonce values if the off-chain generator does not account for Solidity integer truncation.

The withdrawal-expiry refund process is out of audit scope.

The owner can withdraw any native or ERC-20 funds through withdrawEth() and withdrawToken().

The bridge depends heavily on centralized off-chain processes to coordinate cross-chain communication and funds.

Solidity 0.8.20+ introduces PUSH0; deployments on chains without support can fail.

deposit() and withdraw() are payable but have no mechanism to limit or record the submitted msg.value fee.

These are potential-risk observations, not additional entries in the 11-finding register. 

hacken.io

6. Newer public reports in the NEAR Intents repository
These are not formal audit findings, but they are relevant disclosures from the project repository.

Issue

Reported behavior

Public status

#383 — Confidential swaps fail at execution

Cross-asset confidential swaps reportedly fail at deposit submission, return Empty AMQP response, and are refunded with a network fee deducted.

Open

#384 — Confidential swaps misroute deposits

Reporter alleges confidential transfers are marked successful but do not reach the specified recipient.

Open / disputed

Issue #383 describes five unsuccessful attempts over three routes, but the report concerns the confidential swap pipeline, not a demonstrated loss from the NEP-245 contract. 

GitHub

Issue #384 is more complicated. Another commenter explained that tokens sent to the Confidential Intents Treasury are expected to back 1:1 IMT balances on the private FAR network. The reporter disputed that explanation, stating that the intended recipient still did not receive the funds. Public NEAR data cannot independently prove the private-side credit. The issue has commits referencing it, but the page does not show a merged fix or a definitive team resolution. I therefore classify it as disputed and unresolved publicly, not as a confirmed smart-contract exploit. 

GitHub

7. Separate finding: NEAR Omni Bridge replay vulnerability claim
Researcher-reported · not independently accepted
I also found a researcher-authored report concerning a related Rust bridge repository:

NEAR Omni Bridge replay vulnerability research report
It concerns Near-One/omni-bridge, not the HOT OmniBalance contract.

The claimed vulnerability is:

Refund branch removes the replay guard, allowing a previously finalized cross-chain transfer proof to be reused.

The claimed vulnerable path is:

fin_transfer_send_tokens_callback()
    -> is_refund_required()
    -> remove_fin_transfer()

The researcher's claim is that:

A previously finalized transfer has an entry in finalised_transfers.

The receiver's ft_on_transfer returns an amount that requires a refund, or panics.

The refund branch removes the finalized-transfer record.

The original Merkle proof can then be submitted again.

The bridge may process the same transfer a second time.

The report describes a passing unit test demonstrating that the replay guard is removed. However, the full end-to-end economic impact test was not completed in the published write-up.

Status: This is a researcher claim labelled submit-ready, not a vulnerability confirmed by the project or an accepted HackenProof finding. Do not count it among the 41 formal audit findings. 

GitHub

8. Overall findings register
Here is the combined count from the four audit reports whose individual findings I extracted.

41
Formal audit findings extracted

Across four report engagements, excluding exploits and unverified research claims.

Project / report

Findings

NEAR Intents — Hacken 2025

5

NEAR Intents — Guvenkaya 2025

4

HOT Bridge — Veridise 2025

21

HOT Omni Token — Hacken 2024

11

Total

41

Audit-reported remediation status

Fixed

24

Mitigated

1

Accepted

9

Not fixed / scheduled

3

Confirming fix

2

Acknowledged without code fix

1

These categories preserve the reports' own terminology. In particular, accepted does not mean fixed.

9. What I would prioritize investigating
Given the specific relationship between mt_withdraw, mt_batch_transfer_call, mt_on_transfer, and mt_resolve_transfer, these are the findings I would prioritize when reviewing the actual code.

Priority

Finding

Why it deserves investigation

1

Veridise VUL-001

External resolver access and forged callback context

2

Veridise VUL-002

Ambiguous hashing and deposit receiver identification

3

Veridise VUL-003

Nonce lifecycle, cleanup and replay

4

Veridise VUL-004 / VUL-005

Withdrawal authorization and nonce cleanup

5

Veridise VUL-008

Bridge self-receiver and refund accounting

6

Veridise VUL-010

Gas exhaustion in batch-transfer resolver execution

7

September 2026 exploit

Cross-contract accounting divergence after failed asynchronous callbacks

8

Hacken F-2025-8339

Signed-payload compatibility and versioning

For Rust-specific investigation, I would pay particular attention to:

Option::unwrap_or() and default-value fallbacks.

Result handling and swallowed promise failures.

Asynchronous receipt boundaries and rollback assumptions.

Integer rounding and U128 conversion.

Hash construction from concatenated variable-length data.

Nonce removal and replay-protection state.

Serialization and event/log-size constraints.

Callback gas allocation and promise-result interpretation.

10. Important completeness limitations
I don't want to give you a misleading guarantee that these 41 findings represent every vulnerability ever reported against these systems.

NEAR Intents: Its official security page links to a Google Drive collection of audit reports. Guvenkaya's public repository additionally lists a Passkeys Pull Request Security Review. I could identify that report but could not retrieve its PDF contents reliably in this research pass. Therefore its findings, if any, are not included in the count. Other selected engagements may also be private. 

NEAR Intents
+1

HOT Bridge: Veridise's report explicitly covers a NEAR Bridge source-code snapshot, Validation SDK, and Stellar Locker. It does not independently establish that every deployed HOT account was covered by the reviewed commit.

bridge-refuel.hot.tg: I did not locate an independent public audit that explicitly identifies this account as a separately audited contract. The Veridise review is relevant to the HOT bridge architecture, but I would not claim that this particular account was independently audited without a deployment-to-source mapping.

2026 incident: The exploit is real, but the root cause should be attributed to the NEAR Intents refund-resolution accounting path, not automatically to a vulnerability in HOT's own NEP-245 resolver. HOT's treasury was the source of the real asset payouts. 

CertiK
+2

Primary sources and repositories
Resource

What it provides

NEAR Intents source

Rust contract, history, changes and issues

Official Intents security page

Audit collection and bug bounty

HOT Omni Token Solidity source

EVM wallet/bridge implementation

Veridise HOT Bridge audit

2025 Rust bridge and SDK review

Guvenkaya audit repository

NEAR Intents Rust review reports

CertiK incident analysis

2026 HOT Bridge exploit

BlockSec technical incident analysis

Exploit mechanics and financial flow

My recommendation: The highest-value next step is to build a source-to-deployment verification register for the NEAR Bridge and Multi Token contracts. That would map each Veridise finding and remediation PR to the actual deployed code, especially the transfer-call resolver and withdrawal lifecycle. I can also keep the register current by checking new HOT/NEAR audit disclosures and vulnerability reports weekly.



Monitor HOT and NEAR security findings weekly

Tap to set up

good and now i wanna store all finding in one md file and do for all findings in this format:


Rules: 
- write in simple human readable format 
- follow english grammer
- but dont miss any critical idea

Title
   - impact + root cause (max 7 words)
   - simple and plain

Summary:

   - impact + bug description (max 50 words)
   - simple and plain


Root Cause:

   - bullets points (short bullets like 20 words per bullet)


Imapct and Severity:
   - bullest points (short bullets and max 3 major impact bullets)
   - severity (Low, Med, High, Crit)


Attack Flow:
   - list steps

Resolved:
   - if resolved how they resolve it
…
NEAR Intents & HOT Security Findings.md

Markdown · 41 formal findings · 1,285 lines

Created
Download the Markdown file

The file includes:

All 41 formal audit findings, rewritten in your requested format.

Short, plain-English titles and summaries.

Root causes, impacts, severity, and step-by-step attack flows.

Resolution status and explanations of fixes.

The September 2026 HOT Bridge exploit as a separate incident.

A separate researcher-reported vulnerability.

Additional audit risks and primary-source links.

Important: I preserved unresolved and accepted findings rather than describing them as fixed. I also flagged inconsistencies in the Veridise report and areas where public evidence was insufficient.

The 2024 Solidity audit is clearly separated from the Rust NEP-245 contract audit. 

Manuals+
+4

Would you like me to check for new NEAR/HOT findings weekly and prepare updates to this Markdown register?



Monitor NEAR and HOT security findings weekly

Tap to set up


near_intents_hot_security_findings.md
Document
NEAR Intents and HOT Security Findings
Research snapshot: 9 November 2026
Scope: Public audit findings and public vulnerability reports covering NEAR Intents, HOT's NEAR Bridge / Multi Token contract, the HOT Validation SDK, the HOT Stellar Locker, and the related HOT EVM wallet.

How to read statuses: Statuses below are the status stated in the cited report, not a guarantee about the live deployment on 9 November 2026. A report marked Fixed means the auditor or project recorded a fix at the time of that report. It does not prove that every deployed instance runs the fixed commit. Accepted, Acknowledged, Scheduled, and Confirming Fix do not mean fully fixed.

Severity mapping: Where an audit uses Warning, Informational, or Observation, this file maps it to Low so the severity labels follow the requested Low / Med / High / Crit format. The original report rating is preserved in parentheses.

Counting: There are 41 formal findings across four public audit engagements: 5 Hacken NEAR Intents, 4 Guvenkaya NEAR Intents, 21 Veridise HOT Bridge, and 11 Hacken HOT Omni Wallet. The 2026 exploit and the separate researcher disclosure are recorded after the formal findings and are not included in the count.

1. NEAR Intents — Hacken audit (27 January 2025)
Scope: Rust repository near/intents, reviewed commits 160ba5829fea636283375ec462042d51409a6e66 and 91fee5e119fd74d8de1dbb57d27060873a0ae503.
Report: Hacken — Aurora Labs / Defuse Contracts

1.1 F-2025-8337 — Inability to Execute Swap due to Fee Calculation Mechanism
Impact + root cause: Integer fee rounding makes exact swaps impossible.
Summary: The contract charged fees on both negative and positive token deltas. Because each fee was rounded up, some requested swap amounts had no integer value that satisfied the zero-delta balance check. Users could be unable to execute an otherwise valid exact swap.

Root Cause:

Fees were calculated for every token-delta entry.
Both the input decrease and output increase were charged.
fee_ceil() rounded each side separately.
The zero-sum delta invariant could become impossible to satisfy.
Impact and Severity:

Some exact swap amounts could not be executed.
Users might need to accept a different amount or fail the swap.
Small-decimal or low-supply tokens were more affected.
Severity: Med (Medium in the report).
Attack Flow:

A user requests a swap with a precise input amount.
The contract calculates a rounded-up fee on the negative input delta.
It also calculates a rounded-up fee on the positive output delta.
Integer rounding creates a gap: one output amount is too small and the next is too large.
The contract cannot satisfy the exact zero-sum delta check, so the swap fails.
Resolved: Fixed. The contract now charges fees only on negative token deltas (the token-in side). The report identifies commit 877cb9562afa5d11a9b9f8213235be8f8e89695d.

1.2 F-2025-8338 — Profitable Intents Interception due to Front Running
Impact + root cause: Validators can redirect solver rewards through front-running.
Summary: A validator could observe a profitable signed intent, create a competing transaction that changes the receiver of the reward, and include it before the original transaction. The original solver could lose its reward even though it found the opportunity.

Root Cause:

The contract accepted combinations of signed intents.
A profitable intent could be intercepted before execution.
The transaction did not bind the reward to dependent intent execution.
The receiver of the profitable intent could be changed in a copied transaction.
Impact and Severity:

A validator could take a solver's expected reward.
Solvers could lose compensation for completed work.
The report did not describe direct theft from ordinary user balances.
Severity: Med (Medium in the report).
Attack Flow:

A solver prepares a profitable intent containing a self-reward.
The signed intent is visible before it is included in a block.
A validator copies the transaction and changes the reward receiver.
The validator includes the altered transaction first.
The original solver's transaction no longer receives the intended reward.
Resolved: Mitigated, not fully fixed. Commit e697962abcf0f4d6372981faea828e47b6e89078 added a referral field to TokenDiff, allowing referrers to be rewarded through an off-chain mechanism. Hacken explicitly noted that this does not prevent front-running; it provides another way to reward solvers.

1.3 F-2025-8343 — Lack of Full Access Key Verification for Fee Update
Impact + root cause: Restricted fee methods lacked full-access-key verification.
Summary: The fee-update methods checked contract roles but did not verify that the call came from a Full Access Key. A Function Call Key could therefore reach privileged fee-management methods in circumstances the report considered unauthorized, allowing fee or fee-collector changes.

Root Cause:

set_fee() and set_fee_collector() checked role permissions.
They did not require Full Access Key authorization.
Function Call Keys can invoke selected methods without full account authority.
The methods lacked the one-yoctoNEAR Full Access check.
Impact and Severity:

An unauthorized application could change the fee rate.
An unauthorized application could change the fee collector.
Incorrect fees could affect users and protocol revenue.
Severity: Med (Medium in the report).
Attack Flow:

An application receives a Function Call Key.
It invokes a fee-management method through that key.
The method's role checks pass without the required Full Access Key check.
The caller changes the fee or fee-collector account.
Resolved: Fixed. Commit 3eb11613f899dd375e2178d447e5c58a09e6a3b7 added the missing Full Access Key validation. The report shows assert_one_yocto() as the relevant check.

1.4 F-2025-8345 — Native Balance Exhausting due to Unpaid Storage Increase
Impact + root cause: Free state growth can exhaust contract NEAR.
Summary: Intent execution could increase contract storage for user balances and used nonces without checking whether enough NEAR was attached to pay for that growth. A third party could create many small state entries and consume the contract's storage reserve, potentially causing temporary denial of service.

Root Cause:

execute_intents() could allocate new balance and nonce storage.
The method did not require payment for the resulting storage increase.
NEAR locks native tokens to cover contract storage.
Repeated small operations could make the contract fund the storage cost.
Impact and Severity:

Contract NEAR reserves could be depleted.
New state creation could become unavailable.
Some onboarding or intent operations could temporarily stop working.
Severity: Med (Medium in the report).
Attack Flow:

An attacker submits many intents or onboarding operations that create new state.
Each operation adds storage without a matching storage payment.
The contract's staked storage requirement increases.
Its available NEAR reserve falls.
Further operations may fail when the contract cannot cover storage.
Resolved: Accepted, not fixed in the report. The team accepted the risk because requiring an initial storage deposit would make onboarding harder. Hacken recommended checking the contract's initial and final state size and requiring enough attached NEAR to cover the increase. The report says the issue also applies to token-transfer onboarding callbacks.

1.5 F-2025-8339 — Lack of Signed Payload Versioning
Impact + root cause: Unversioned signatures complicate safe contract upgrades.
Summary: Signed payloads did not contain an explicit version. Because the contract is upgradeable, future changes to payload structures could make it difficult to distinguish old signed messages from new formats and safely support multiple versions.

Root Cause:

DefusePayload had no explicit version field.
The contract was designed to be upgradeable.
The execution path did not validate a payload version.
Future format changes could create compatibility or interpretation problems.
Impact and Severity:

Future upgrades could be harder to support safely.
Old and new signed payload formats could be difficult to distinguish.
The report did not demonstrate an immediate funds-theft path.
Severity: Low (Low in the report).
Attack Flow:

A user signs a payload using the current structure.
The contract is upgraded and the payload structure changes.
The contract has no explicit version to identify the signed format.
Supporting or validating old and new payloads becomes more difficult.
Resolved: Accepted for future work, not fixed in the report. Hacken recommended adding a version field and validating it during signed-intent execution. The team accepted the issue and stated that versioning would be implemented in a future update.

2. NEAR Intents — Guvenkaya security review (12 February–5 March 2025)
Scope: NEAR Intents Rust contracts, intent engine, payload verification, and cryptography crates. Reviewed baseline 6da9e2b3ab598f277d45fb356aee01a5d80ac0a6.
Report: Guvenkaya — NEAR Intents Security Review

2.1 GUV-1 — Potential Funds Stealing From Users Via Repeating Failed Intents
Impact + root cause: Failed transactions can enable intent replay.
Summary: An attacker could deliberately fail an intent transaction and then reconstruct selected signed intents while their deadlines remained valid. This could enable token theft or unauthorized solver actions, especially in peer-to-peer flows that did not use TokenDiff.

Root Cause:

A transaction could fail after a user had signed its intents.
The nonce could be invalidated separately after signing.
An added intent could make the transaction fail its TokenDiff check.
Failed transaction contents remained observable while their deadlines were valid.
Selected intents could be reconstructed and resubmitted.
Impact and Severity:

Funds could be stolen in flows that did not use TokenDiff.
Solvers could lose funds or face unauthorized operations.
The report rated likelihood as rare and impact as severe.
Severity: Med (Medium in the report).
Attack Flow:

A user signs a transaction containing several intents.
The attacker causes the transaction to fail, for example by invalidating its nonce separately.
The attacker reads the failed transaction and extracts selected intents.
The attacker reconstructs and resubmits those intents before their deadlines expire.
The replay may execute in a context that benefits the attacker or harms a solver.
Resolved: Scheduled, not confirmed fixed. The team planned to document the risk and recommend TokenDiff for swaps while discouraging Transfer for swap execution. This is documentation guidance, not a demonstrated contract-level replay-protection fix.

2.2 GUV-2 — Possible DoS Of Public Keys Viewing Per User
Impact + root cause: Unlimited keys make account-key reads run out of gas.
Summary: Users could accumulate unlimited public keys. The public_keys_of() method iterated over and collected every key into a set. A sufficiently large key list could exceed the gas limit and make the method fail for that account.

Root Cause:

Accounts had no maximum public-key count.
public_keys_of() iterated over all keys for an account.
The iterator collected the complete result into a HashSet.
The work and memory cost grew with the key count.
Impact and Severity:

Off-chain systems calling public_keys_of() could fail.
Other on-chain flows using the same iteration could face denial of service.
The report rated the impact as negligible and likelihood as possible.
Severity: Low (Low in the report).
Attack Flow:

An attacker adds a very large number of public keys to their account.
A service or contract calls public_keys_of() for that account.
The method iterates over and collects the full key list.
Execution exceeds the available gas and returns an error.
Resolved: Not fixed in the report. Guvenkaya recommended enforcing a maximum number of public keys per account. The report states that the team had not fixed the issue by the final review.

2.3 GUV-3 — Arbitrary Public Key Setting In Privileged Functions
Impact + root cause: Weak key validation can admit unsafe public keys.
Summary: The code accepted public keys in several account and privileged-key operations without comprehensive validation. The report warned that malformed or weak keys could reach cryptographic operations and cause undefined behavior or signature-malleability risks.

Root Cause:

The NEAR SDK PublicKey type did not validate every relevant property.
Several methods accepted keys without additional checks.
Account, relayer, and Full Access Key paths shared the concern.
Cryptographic operations could receive malformed or weak key values.
Impact and Severity:

Invalid keys could cause unexpected cryptographic behavior.
Weak keys could increase signature-malleability risk.
The report rated impact negligible and likelihood rare.
Severity: Low (Informational in the report).
Attack Flow:

An attacker supplies a malformed or weak public key to a key-management operation.
The operation accepts the key without complete validation.
The key is stored and later used by a cryptographic or authorization path.
That path may behave unexpectedly or rely on an unsafe key.
Resolved: Not fixed in the report. Guvenkaya recommended explicit validation in add_public_key, remove_public_key, do_add_relayer_key, delete_relayer_key, add_full_access_key, and delete_key().

2.4 GUV-4 — Missing Event Emission For Critical Access Control Operations
Impact + root cause: Relayer-key changes are not visible to monitors.
Summary: Adding or deleting relayer keys did not emit events. This made it difficult for off-chain monitoring and audit systems to reconstruct changes to the set of accounts authorized to relay operations.

Root Cause:

do_add_relayer_key() did not emit an event.
delete_relayer_key() did not emit an event.
Off-chain systems depended on events to track access-control changes.
Impact and Severity:

Relayer authorization changes were harder to monitor.
Security investigations and audit trails could be incomplete.
The report rated impact negligible and likelihood rare.
Severity: Low (Informational in the report).
Attack Flow:

An administrator adds or removes a relayer key.
The contract updates the relayer-key state.
No corresponding event is emitted.
Off-chain monitors may not detect or reconstruct the change from events alone.
Resolved: Not fixed in the report. The recommendation was to emit events for both relayer-key addition and removal. Guvenkaya stated that the team had not fixed the issue by the final report.

3. HOT Bridge — Veridise audit (1 September 2025)
Scope: Three Rust components: NEAR Bridge / OmniBalance (356f6eb), Validation SDK (8729129), and Stellar Locker (65520e7). The NEAR Bridge scope included NEP-245 core transfers and resolver, storage management, deposits, withdrawals, and nonce/proof handling.
Report: Veridise — HOT Bridge Audit PDF
Finding totals in report: 21 findings: 1 Critical, 5 High, 4 Medium, 4 Low, 6 Warning, and 1 Informational. The summary table records 18 fixed and 3 not fixed. Original Warning and Informational severities are mapped to Low below.

3A. NEAR Bridge / OmniBalance / NEP-245
3.1 V-HOTB-VUL-001 — Lack of access control in resolve function enables arbitrary token transfers
Impact + root cause: Public resolver access enables forged refunds.
Summary: mt_resolve_transfer() was not private. Another contract could create a promise callback to invoke it with attacker-controlled parameters, making the bridge process a fake failed transfer and refund tokens from another user's balance.

Root Cause:

NEP-245 requires the resolver to be callable only by the token contract.
The method was not marked #[private].
Runtime promise-result checks did not provide sufficient protection from another contract.
The resolver accepted attacker-controlled callback parameters.
Impact and Severity:

An attacker could transfer tokens from another user's account.
The bridge's refund logic could be triggered without a real transfer callback.
Severity: Crit (Critical in the report).
Attack Flow:

The attacker deploys or uses a contract that can create an asynchronous promise chain.
The attacker makes the bridge resolver the callback target.
The callback invokes mt_resolve_transfer() with crafted parameters.
The public resolver treats the call as a legitimate transfer resolution.
The refund path moves tokens from a victim to the attacker.
Resolved: Fixed. HOT marked mt_resolve_transfer() as #[private] instead of #[payable]. Confirmed fix: hot-bridge PR #14, commit 06c055e.

3.2 V-HOTB-VUL-002 — Bridge tokens can be minted to attacker due to mt_deposit_call() hash collision
Impact + root cause: Ambiguous input hashing misbinds deposit receivers.
Summary: mt_deposit_call() built a receiver identifier by hashing the concatenation of two variable-length user inputs. Different account_id and msg pairs could produce the same concatenated bytes, allowing an attacker to reuse a valid deposit signature for altered parameters.

Root Cause:

account_id and msg were variable-length user-controlled fields.
The fields were concatenated before hashing.
No separator or structured encoding distinguished the fields.
Different input pairs could therefore produce the same hash input.
Impact and Severity:

A signed deposit could be redirected to an attacker-controlled call.
The attacker could steal tokens associated with the valid deposit.
Severity: High (High in the report).
Attack Flow:

A user obtains a valid signature for a deposit call.
The attacker constructs different account_id and msg values with the same concatenated bytes.
The attacker submits the colliding call before the user.
The bridge verifies the same receiver hash and accepts the altered call.
The attacker receives the deposited bridge tokens or call benefit.
Resolved: Fixed. The receiver identifier is now derived from the JSON representation of the structured deposit-call arguments. The funds are also routed first to the bridge owner's address rather than using the caller as an intermediary. Confirmed fix: hot-bridge PR #15.

3.3 V-HOTB-VUL-003 — Double spend attack due to missing nonce freshness check
Impact + root cause: Expired nonce cleanup reopens replayed deposits.
Summary: The owner could clear old used nonces after an 18-day cache period, but deposit() did not reject stale nonce values. An attacker could wait for a used nonce to be removed and submit the same deposit nonce again.

Root Cause:

Used deposit nonces were stored to prevent replay.
An owner function deleted old nonce entries to control storage growth.
deposit() did not independently check nonce freshness.
A deleted nonce could later appear unused.
Impact and Severity:

A previously used deposit proof could be replayed.
The bridge could mint or credit tokens more than once for one deposit.
Severity: High (High in the report).
Attack Flow:

A legitimate deposit uses nonce n.
The nonce remains in the used-nonce store until it becomes old.
The owner clears the expired nonce entry.
An attacker resubmits a deposit using the same nonce and proof.
Without a freshness check, the bridge may accept the reused nonce.
Resolved: Fixed. The nonce-tracking data structure was changed so an old nonce cannot be added and a nonce cannot be removed before it is old enough. Confirmed fix: hot-bridge PR #21.

3.4 V-HOTB-VUL-004 — Griefing attack on user withdrawals due to missing access control checks
Impact + root cause: Public nonce-key setters allow withdrawal cancellation.
Summary: The functions that set or remove the public key used for withdrawal-nonce cleanup lacked owner-only access control. An attacker could replace the trusted key, clear a user's pending withdrawal nonce, and prevent MPC nodes from signing the withdrawal after the user's bridge tokens had already been burned.

Root Cause:

set_public_key_for_nonce_removal() lacked owner-only protection.
remove_public_key_for_nonce_removal() lacked owner-only protection.
The cleanup signature was checked against a configurable public key.
Clearing a pending nonce removed the data needed for MPC verification.
Impact and Severity:

A victim's pending withdrawal could become impossible to complete.
The victim's bridge tokens could already have been burned.
The victim could suffer an irrecoverable loss of funds.
Severity: High (High in the report).
Attack Flow:

A user starts a withdrawal and receives nonce n1.
The attacker removes the currently configured nonce-cleanup public key.
The attacker registers their own public key for that chain.
The attacker signs and calls clear_completed_withdrawal(n1).
The pending nonce is deleted before MPC signs the victim's withdrawal.
The victim's already-burned bridge tokens cannot be withdrawn.
Resolved: Fixed. Both public-key management methods were changed so only the bridge owner can call them. Confirmed fix: hot-bridge PR #18.

3.5 V-HOTB-VUL-005 — Withdrawal receiver is unable to clean nonces for themselves
Impact + root cause: Missing receiver-signature support blocks nonce cleanup.
Summary: The receiver needed to clear a used withdrawal nonce before making another withdrawal. For Stellar- and TON-bound withdrawals, receiver-based cleanup was not implemented, and MPC cleanup signatures were unavailable, leaving sender cooperation as the only practical route.

Root Cause:

clear_withdrawal_by_receiver() was not implemented for Stellar and TON.
clear_completed_withdrawal() was not implemented in the MPC service.
The Validation SDK lacked the nonce-cleaning signature generation function.
Sender cleanup required coordination when sender and receiver differed.
Impact and Severity:

A receiver could be blocked from processing later withdrawals.
Users depended on another party to clear a used nonce.
Severity: High (High in the report).
Attack Flow:

A user initiates a withdrawal to a different receiver.
The receiver claims the funds on the destination chain.
The receiver tries to clear the used nonce on NEAR.
Receiver cleanup or MPC cleanup is unavailable for that destination.
The sender must perform cleanup, but may be unavailable or unwilling.
The receiver's next withdrawal can remain blocked.
Resolved: Confirming Fix in the report. Developers confirmed the issue and agreed to add Stellar signature support in verify_against_user_public_key(). The report lists no confirmed fix commit. The related SDK limitation is separately recorded as Validation SDK finding V-HOTB-VUL-001.

3.6 V-HOTB-VUL-006 — Million Small Deposits attack through storage_deposit() function
Impact + root cause: Tiny deposits make the bridge pay storage costs.
Summary: storage_deposit() could create a balance record for another account while charging too little to cover the storage cost. An attacker could create many tiny balances and make the bridge pay the difference, draining its NEAR reserve.

Root Cause:

A caller could register or fund another account.
The contract paid the storage staking cost for new balance entries.
The caller could deposit as little as one yoctoNEAR.
The function did not charge the user the actual storage cost.
Impact and Severity:

The bridge's NEAR balance could be drained.
New deposits, transfers, or withdrawals could stop when storage funding ran low.
Severity: Med (Medium in the report).
Attack Flow:

The attacker calls storage_deposit() for many new account IDs.
Each call adds a balance entry but pays too little NEAR.
The bridge stakes its own NEAR to cover the storage.
Repeated calls consume the bridge's available NEAR.
Operations that need new storage may fail.
Resolved: Fixed. storage_deposit() now requires a minimum deposit covering 200 bytes of storage and honors the NEP-145 registration_only flag. Confirmed fix: hot-bridge PR #22.

3.7 V-HOTB-VUL-007 — Empty withdrawal requests can be used to block specific users
Impact + root cause: Zero-value requests clog single-withdrawal queues.
Summary: withdraw() accepted zero-value requests. An attacker could create many empty withdrawal requests for a victim. Because the protocol allowed only one pending withdrawal to be signed at a time and cleanup was not batched, the victim had to clear every empty request before withdrawing.

Root Cause:

withdraw() did not reject a zero amount.
An attacker could target another user's withdrawal queue.
Only one pending withdrawal could be signed at a time.
Nonce cleanup required separate calls for each request.
Impact and Severity:

A victim's legitimate withdrawal could be delayed or blocked.
The attacker could create many requests at low cost.
Severity: Med (Medium in the report).
Attack Flow:

The attacker submits many zero-value withdrawal requests targeting a victim.
The requests fill the victim's pending-withdrawal queue.
The victim tries to initiate a real withdrawal.
The victim must clear each empty nonce individually.
The cleanup burden delays or prevents the real withdrawal.
Resolved: Fixed. The project added batch nonce-cleaning functions and adjusts withdrawal fees based on the length of the pending queue. Confirmed fix: hot-bridge PR #24.

3.8 V-HOTB-VUL-008 — Bridge account vulnerable to unauthorized fund withdrawals via NEP-245 transfer call
Impact + root cause: Self-directed transfer calls trigger bridge refunds.
Summary: Sending a NEP-245 transfer call to the bridge's own account entered withdrawal logic. The bridge did not implement mt_on_transfer(), so the call failed and resolver logic refunded tokens from the bridge's own balance to the attacker.

Root Cause:

internal_mt_batch_transfer() treated the bridge as a special withdrawal receiver.
The bridge did not implement the receiver callback mt_on_transfer().
A failed callback caused mt_resolve_transfer() to refund the transfer.
The refund could be taken from the bridge's own token balance.
Impact and Severity:

An attacker could withdraw tokens held in the bridge account.
The attacker could receive a refund without providing a valid external withdrawal.
Severity: Low (Low in the report).
Attack Flow:

The attacker calls mt_transfer_call() or mt_batch_transfer_call() with the bridge as receiver.
The bridge's internal transfer logic creates withdrawal behavior.
The receiver callback fails because the bridge has no mt_on_transfer() implementation.
The resolver attempts to refund the tokens.
If the bridge holds that token, its balance can be paid to the attacker.
Resolved: Fixed. internal_mt_batch_transfer() now rejects the bridge account as the receiver. Confirmed fix: hot-bridge PR #25.

3.9 V-HOTB-VUL-009 — Non-compliance with NEP-145
Impact + root cause: Storage methods do not follow NEP-145 behavior.
Summary: The storage-management implementation ignored the registration_only flag, did not implement storage_unregister(), and did not charge users for the storage cost of their balance records. This could cause unexpected storage-balance behavior and disagreement between reported and withdrawable amounts.

Root Cause:

storage_deposit() ignored the registration_only argument.
storage_unregister() was not implemented.
User balance records were not charged their actual storage cost.
storage_balance_of() could therefore overstate the amount available to withdraw.
Impact and Severity:

Users could receive behavior different from the NEP-145 specification.
Storage balance and withdrawable amounts could disagree.
Severity: Low (Low in the report).
Attack Flow:

A user calls storage-management methods expecting NEP-145 behavior.
The bridge ignores registration_only or cannot process unregister requests.
The reported storage balance may not match the amount the user can recover.
The user experiences unexpected registration or withdrawal behavior.
Resolved: Marked Fixed in the report summary; response is inconsistent. The report associates the fix with hot-bridge PR #22, which adds a minimum deposit and correct registration_only handling. However, the detailed text says the developers had not yet acknowledged the broader NEP-145 issue. Treat full compliance, especially storage_unregister(), as requiring independent source verification.

3.10 V-HOTB-VUL-010 — Unbounded token batch transfer may lead to token loss in some scenarios
Impact + root cause: Large batches can exhaust resolver gas.
Summary: mt_batch_transfer_call() accepted unlimited token entries. Decoding many Base58 token IDs could consume enough gas that mt_resolve_transfer() could not refund rejected tokens, potentially causing partial or complete token loss.

Root Cause:

The batch-transfer method had no maximum entry count.
Token IDs required Base58 decoding during execution.
Large batches increased resolver gas use.
A failed receiver callback still required refund processing.
Impact and Severity:

The resolver could run out of prepaid gas.
Rejected tokens might not be refunded.
The report tested batches of about 130 entries near the 7 TGas resolver limit.
Severity: Low (Low in the report).
Attack Flow:

A user submits a very large batch with limited gas.
The receiver rejects some tokens or its callback fails.
The bridge starts mt_resolve_transfer() to refund the sender.
Base58 decoding and batch processing consume the resolver's gas.
The resolver aborts before completing the refund.
Resolved: Fixed. The developers limited mt_batch_transfer_call() to 100 tokens. Confirmed fix: hot-bridge PR #27.

3.11 V-HOTB-VUL-011 — Bridge init call front-running risk
Impact + root cause: Public initialization lets attackers seize ownership.
Summary: The bridge constructor was not marked private. If deployment did not initialize the contract through the expected deployment path, an attacker could call new() first, set themselves as owner, and gain access to privileged bridge methods.

Root Cause:

Contract::new() was not marked #[private].
The code allowed an arbitrary caller to initialize an uninitialized contract.
Initialization assigned the owner and privileged configuration.
Impact and Severity:

An attacker could become bridge owner.
The attacker could call privileged methods and change bridge configuration.
Severity: Low (Warning in the report).
Attack Flow:

The bridge is deployed without being initialized in the same secure deployment flow.
The attacker observes that initialization remains available.
The attacker calls Contract::new() first.
The attacker becomes owner and gains privileged access.
Resolved: Fixed. The constructor was marked #[private]. Confirmed fix: hot-bridge PR #23.

3.12 V-HOTB-VUL-012 — Minor Code Quality Issues
Impact + root cause: Unsafe convenience patterns increase future bug risk.
Summary: Veridise listed maintainability problems across the NEAR Bridge, including unused fields, unclear names, redundant storage variants, manual yoctoNEAR checks, and an unchecked unwrap() on an optional memo. These were not reported as direct security vulnerabilities.

Root Cause:

Some fields and storage-key variants were unused.
Several names and comments did not match actual behavior.
The withdrawal method manually checked one yoctoNEAR.
The NEP-245 code unwrapped an optional memo without checking it.
Impact and Severity:

The listed issues had no direct security impact in the report.
They could make future maintenance harder and bugs more likely.
Severity: Low (Informational in the report).
Attack Flow:

No direct attacker flow was established. The unchecked memo could make a call panic when the memo was absent.
Resolved: Marked Fixed in the report summary. The report points to hot-bridge PR #29. However, the detailed developer-response text says the issue had not yet been acknowledged. Treat the summary status and detailed response as inconsistent until the PR is checked against the deployed source.

3B. HOT Validation SDK
3.13 V-HOTB-SDK-001 — SDK is missing nonce cleaning signature generation function
Impact + root cause: SDK cannot create required withdrawal-cleanup signatures.
Summary: The protocol supported cleanup of completed withdrawal nonces using an MPC signature, but the SDK could not generate that signature. For Stellar withdrawals, receiver cleanup was also incomplete, leaving sender cleanup as the only route when sender and receiver differed.

Root Cause:

The SDK lacked nonce-cleanup signature generation.
clear_completed_withdrawal() required a specific MPC signature.
Stellar receiver-based cleanup was not fully implemented.
Sender and receiver could be different parties.
Impact and Severity:

Receivers could be unable to clean completed withdrawal nonces.
Later withdrawals could remain blocked without sender cooperation.
Severity: High (High in the report).
Attack Flow:

A user initiates a withdrawal to a different receiver.
The receiver claims the funds on the destination chain.
The receiver needs a signed cleanup request for the NEAR nonce.
The SDK cannot generate the required MPC cleanup signature.
The sender must perform cleanup, but may not cooperate.
The receiver may be unable to make the next withdrawal.
Resolved: Confirming Fix in the report. Developers confirmed the issue and agreed to add the missing SDK logic. No confirmed fix commit is listed in the report.

3.14 V-HOTB-SDK-002 — Inaccurate criteria for signature generation can result in loss of funds
Impact + root cause: Response order can bypass majority validation.
Summary: The SDK could produce an MPC signature when only a threshold number of servers agreed, even if the honest majority rejected the request. The outcome could depend on the order in which server responses arrived.

Root Cause:

Consensus used a threshold count without enforcing a strict majority.
The configured threshold could be two out of five servers.
The decision could depend on response arrival order.
A minority of dishonest servers could produce a positive result.
Impact and Severity:

Invalid deposits or withdrawals could receive a valid signature.
A bad signature could enable unauthorized asset movement or locker drainage.
Severity: Med (Medium in the report).
Attack Flow:

The service is configured with five validators and threshold two.
Two dishonest validators approve an invalid request.
Three honest validators reject it.
The dishonest approvals arrive first.
The implementation reaches the threshold and may return approval before processing the honest majority.
An invalid operation receives an MPC signature.
Resolved: Fixed. The SDK now validates configuration so the threshold must be strictly greater than half the server count. Confirmed fix: hot-validation-sdk PR #4.

3.15 V-HOTB-SDK-003 — Servers collection allows for duplicates
Impact + root cause: Duplicate validator entries distort vote counts.
Summary: The SDK stored validator addresses in a Vec, which allowed the same server to appear more than once. Duplicate entries could give one validator multiple votes and manipulate threshold decisions.

Root Cause:

The server collection used a vector.
Vector entries were not required to be unique.
Repeated addresses could be counted as separate validators.
Impact and Severity:

One validator could receive multiple votes in a configuration.
A low threshold could be reached without enough independent validators.
Severity: Low (Low in the report).
Attack Flow:

A configuration includes the same validator address several times.
The SDK counts each vector entry separately.
The repeated server's response can satisfy more than one vote.
The configured threshold may be reached without enough independent agreement.
Resolved: Fixed. Configuration deserialization now checks that all server addresses are unique. Confirmed fix: hot-validation-sdk PR #4.

3.16 V-HOTB-SDK-004 — Maintainability issues
Impact + root cause: Inconsistent SDK validation and metadata handling.
Summary: Veridise found inconsistent validation and documentation across the SDK. Some fields were not validated for EVM and Stellar, metadata was ignored by the NEAR bridge, a payload field was ambiguously documented, and tests could fail under RPC rate limits.

Root Cause:

wallet_id and metadata were not checked for emptiness on all chains.
The NEAR bridge ignored metadata not present in its function parameters.
user_payload documentation did not clearly describe its nonce role.
EVM tests depended on an RPC endpoint with rate limits.
Chain identifiers differed between the SDK and NEAR side.
Impact and Severity:

Configuration mistakes could be harder to identify.
Tests could fail because of external RPC limits.
The report treated these as maintainability issues, not direct exploits.
Severity: Low (Warning in the report).
Attack Flow:

No direct attacker flow was established. Invalid or inconsistent configuration could cause incorrect verifier behavior or unreliable tests.
Resolved: Marked Fixed in the report. The report identifies commit 06ba9ce. Developers said most observations were addressed, but the RPC-rate-limit test issue remained outstanding at the time of the response.

3.17 V-HOTB-SDK-005 — EVM verifier config is taken from Stellar entries by mistake
Impact + root cause: EVM verifier loads the wrong chain configuration.
Summary: When building EVM verifiers, the SDK filtered out NEAR configuration entries but did not filter out Stellar entries. A Stellar configuration could therefore be passed into the EVM verifier collection.

Root Cause:

The EVM configuration filter excluded ChainId::Near only.
It did not exclude ChainId::Stellar.
The remaining configurations were used to build EVM verifiers.
Impact and Severity:

Stellar configuration could be treated as EVM configuration.
Verifier initialization or chain-specific validation could behave incorrectly.
Severity: Low (Warning in the report).
Attack Flow:

The SDK loads configuration for NEAR, Stellar, and EVM chains.
It builds the EVM verifier list.
It filters out NEAR but leaves Stellar entries.
The EVM verifier is initialized with an unrelated Stellar configuration.
Resolved: Fixed. The filter was corrected to exclude Stellar entries from the EVM verifier configuration. Confirmed fix: hot-validation-sdk PR #3.

3C. HOT Stellar Locker
3.18 V-HOTB-LOCKER-001 — Lack of domain separation between deposit and withdrawal messages allows invalidating arbitrary nonces
Impact + root cause: Shared payload format enables cross-operation nonce griefing.
Summary: Deposit and withdrawal signatures used payloads without a field identifying the operation type. A user-controlled deposit nonce could match another user's withdrawal nonce, allowing a deposit signature to be accepted as a withdrawal signature and consume the withdrawal nonce.

Root Cause:

Deposit and withdrawal payloads lacked a type-specific domain separator.
Deposit client_timestamp was supplied by the user as a nonce.
Withdrawal nonces were generated by the NEAR bridge.
The same signature format could be interpreted by both locker operations.
Impact and Severity:

An attacker could invalidate a legitimate withdrawal nonce.
A victim could lose access to funds already burned on NEAR.
Severity: Med (Medium in the report).
Attack Flow:

Alice starts a withdrawal on the NEAR bridge and receives nonce n.
Mallory makes a Stellar deposit and chooses n as her client_timestamp.
MPC signs Mallory's deposit payload.
Mallory submits that signature to the Stellar withdrawal path.
Because the payload lacks operation-type separation, the locker accepts the signature as a withdrawal.
The shared nonce is marked as used, interfering with Alice's withdrawal.
Resolved: Acknowledged, not code-fixed in the report. Developers relied on separate deposit and withdrawal public keys as an operational safeguard instead of adding domain separation to the signed payload. The report did not record a code-level fix.

3.19 V-HOTB-LOCKER-002 — Change of owner does not use two step pattern
Impact + root cause: Single-step ownership can permanently lock administration.
Summary: set_owner() immediately replaced the current owner without requiring the new owner to accept. An incorrect or inaccessible address could become owner and make all privileged functions unusable.

Root Cause:

Ownership changed in one transaction.
The new address did not need to accept ownership.
The old owner lost control immediately after the update.
Impact and Severity:

An incorrect owner address could permanently lock privileged methods.
Administrative recovery and fund-management operations could become unavailable.
Severity: Low (Warning in the report).
Attack Flow:

The current owner enters an incorrect or inaccessible new owner address.
set_owner() stores it immediately.
The new address cannot or will not operate the contract.
The old owner has already lost authority.
Privileged functions become inaccessible.
Resolved: Fixed. Developers implemented a two-step ownership transfer in which the proposed owner must accept before ownership changes. Confirmed fix: stellar-hot-bridge PR #2.

3.20 V-HOTB-LOCKER-003 — Maintainability issues
Impact + root cause: Misleading names and redundant code hide risks.
Summary: The Stellar Locker contained naming and maintainability problems, including an unclear nonce parameter name, a missing chain-ID constant, redundant code, and an unused wallet parameter. The report also warned that the redundant clear_deposit() function could remove a still-valid nonce and lock funds.

Root Cause:

client_timestamp was actually a deposit nonce.
Chain IDs were manually appended instead of using a named constant.
Some code and fields were redundant or unused.
clear_deposit() could remove a nonce without checking freshness.
Impact and Severity:

The report found no direct security impact for most listed items.
Misuse of clear_deposit() could lock a valid deposit.
Poor naming and redundant logic increase future bug risk.
Severity: Low (Warning in the report).
Attack Flow:

An administrator or operator calls the redundant cleanup function.
The function removes a nonce without checking whether it is still valid.
A legitimate deposit or withdrawal can no longer complete as expected.
Resolved: Marked Fixed in the report summary, but response is inconsistent. The report lists stellar-hot-bridge PR #1, while the detailed developer response says the issue had not been acknowledged. Verify the specific cleanup behavior in current source.

3.21 V-HOTB-LOCKER-004 — Incorrect order of arguments when extending instance TTL
Impact + root cause: Reversed TTL arguments shorten storage lifetime.
Summary: The Locker called Soroban's extend_ttl() with the extension amount and threshold in the wrong order. As a result, the instance TTL was extended to the shorter threshold value rather than the intended longer bump value.

Root Cause:

Soroban expects extend_ttl(threshold, extend_to).
The contract passed INSTANCE_BUMP_AMOUNT first.
The contract passed INSTANCE_LIFETIME_THRESHOLD second.
The two constants had different values.
Impact and Severity:

The contract instance received a shorter TTL than intended.
The instance could expire earlier than the developers expected.
Severity: Low (Warning in the report).
Attack Flow:

The owner calls increase_instant_ttl().
The function calls extend_ttl() with reversed arguments.
Soroban applies the threshold as the extension target.
The instance receives the shorter 100-day value instead of the intended 120-day value.
Resolved: Fixed. Developers swapped the arguments to match the Soroban API. Confirmed fix: stellar-hot-bridge PR #1.

4. HOT Omni Token EVM wallet — Hacken audit (9 October 2024)
Important scope note: This is the Solidity-based MetaWallet / RlpEncode multi-chain wallet in hot-dao/omni-wallet-solidity, not the Rust NEP-245 contract at v2_1.omni.hot.tg. The audit reviewed commit 40ff89f and listed 11 findings: 4 fixed and 7 accepted.
Report: Hacken — HOT Wallet / Hot Omni Token, September 2024

4.1 F-2024-6207 — Precompile ecrecover May Lead to Signature Malleability
Impact + root cause: Malleable signatures can bypass signature uniqueness.
Summary: The report identified signature-malleability risk in the use of the EVM ecrecover precompile. If the application treats different encodings of the same signer signature as different authorizations, signature checks or replay tracking may be bypassed.

Root Cause:

Signature recovery relied on the ecrecover precompile.
The report identified missing protection against malleable signature forms.
Equivalent signatures could potentially recover the same signer.
Impact and Severity:

Signature uniqueness checks may be unreliable.
A malleable signature could undermine authorization or replay controls.
Severity: Med (Medium in the report).
Attack Flow:

A legitimate signer creates a valid signature.
An attacker transforms it into another accepted malleable representation.
The recovered signer remains the same.
A system that tracks the signature bytes rather than canonical authorization may treat it as a new signature.
Resolved: Fixed in the audit. Hacken marks the finding fixed. The public audit index does not expose enough detail to identify the exact final code change, so the precise patch is not independently stated here.

4.2 F-2024-6228 — Unchecked Return Value in Token Transfer May Lead to Unexpected Behavior
Impact + root cause: False token transfers may be treated as successful.
Summary: Some ERC-20 tokens return false when a transfer fails instead of reverting. If the wallet ignores the return value, it may continue as though tokens were transferred even though the asset movement failed.

Root Cause:

The token transfer return value was not checked.
ERC-20 implementations can return false without reverting.
The caller could continue after a failed transfer.
Impact and Severity:

Deposits or withdrawals could be recorded incorrectly.
Contract and user accounting could diverge from actual token balances.
Severity: Low (Low in the report).
Attack Flow:

A user initiates a token transfer.
The token contract returns false instead of reverting.
The wallet does not check the result.
The wallet continues as though the transfer succeeded.
Resolved: Fixed in the audit. Hacken marks the finding fixed. The public indexed report does not expose the exact patch details.

4.3 F-2024-6225 — Lack of EIP712 Compliance May Result in Signature Replay
Impact + root cause: Missing typed-data domain separation enables replay.
Summary: The wallet did not fully follow EIP-712 typed-data signing. Without a properly bound domain, a valid signature may be reusable in another contract or chain context where the signed data is interpreted the same way.

Root Cause:

The signing format did not fully follow EIP-712.
The signature domain was not adequately bound to execution context.
Chain and contract separation could therefore be weaker than intended.
Impact and Severity:

A valid authorization could potentially be replayed in another context.
Replayed signatures could authorize unintended deposits or withdrawals.
Severity: Low (Low in the report).
Attack Flow:

A user signs a wallet operation.
The same signed data is accepted in another compatible context.
The wallet does not sufficiently distinguish the chain or verifying contract.
The authorization may be replayed.
Resolved: Accepted, not fixed in the report. Hacken records the issue as accepted. No EIP-712 remediation is recorded in the public finding index.

4.4 F-2024-6222 — Use of transfer() to Send Native Assets may Revert
Impact + root cause: Gas-limited native transfers can revert.
Summary: Solidity's transfer() forwards a very small gas stipend. A recipient contract whose fallback or receive function needs more gas can reject the payment, causing the wallet's native-asset transfer to revert.

Root Cause:

The contract used Solidity transfer() for native assets.
transfer() forwards only the fixed stipend.
Some recipient contracts need more gas to accept funds.
Impact and Severity:

Withdrawals to some contract recipients could fail.
A user might be unable to receive native assets at the chosen address.
Severity: Low (Low in the report).
Attack Flow:

A user requests a native-asset withdrawal to a contract wallet.
The recipient's fallback function needs more gas than the stipend.
transfer() reverts.
The withdrawal transaction fails.
Resolved: Fixed in the audit. Hacken marks the finding fixed. The public indexed report does not expose the exact replacement code.

4.5 F-2024-6262 — Unused Code Should be Removed
Impact + root cause: Dead code increases maintenance risk.
Summary: The audit identified code that was not used by the wallet. Unused code increases review effort and can confuse future changes, although the report did not identify a direct exploit.

Root Cause:

Unused code remained in the audited contracts.
The codebase did not remove obsolete implementation pieces.
Impact and Severity:

Review and maintenance become harder.
Unused code can confuse future development.
Severity: Low (Observation in the report).
Attack Flow:

No direct attack flow was reported.
Resolved: Fixed. Hacken marks the unused code finding as fixed. The public index does not provide a specific patch description.

4.6 F-2024-6261 — Missing Zero Address Checks
Impact + root cause: Zero-address configuration can disable wallet functions.
Summary: The audited code lacked checks that important address values were not zero. A zero owner, verifier, or other critical address can make functionality unusable or direct authorization checks to an invalid address.

Root Cause:

Important address inputs were not consistently checked against address(0).
Critical configuration could be set to an unusable address.
Impact and Severity:

Critical wallet operations could become unusable.
An invalid verifier or administrator address could disrupt authorization.
Severity: Low (Observation in the report).
Attack Flow:

An authorized configuration operation receives a zero address.
The contract stores the value without rejecting it.
Later calls depend on that address for ownership or verification.
Those calls may fail or become inaccessible.
Resolved: Accepted, not fixed in the report. Hacken records the finding as accepted.

4.7 F-2024-6260 — Single-Step Owner Transfer May Cause DOS
Impact + root cause: One-step ownership transfer can lock administration.
Summary: Ownership could be changed immediately without acceptance by the new owner. If the wrong or inaccessible address was entered, the previous owner would lose control and the new owner might be unable to manage the wallet.

Root Cause:

Ownership changed in a single step.
The proposed new owner did not need to accept.
The old owner lost authority immediately.
Impact and Severity:

A mistaken transfer could permanently lock owner functions.
Administrative recovery could become impossible.
Severity: Low (Observation in the report).
Attack Flow:

The owner submits a new owner address.
The contract updates ownership immediately.
The address is incorrect or cannot operate the wallet.
The former owner no longer has control.
Resolved: Accepted, not fixed in the report. Hacken records the finding as accepted.

4.8 F-2024-6236 — Missing Event Emission
Impact + root cause: Important state changes are not observable off-chain.
Summary: Some important operations did not emit events. Off-chain services and auditors could therefore miss or fail to reconstruct configuration and administrative changes from the event history.

Root Cause:

Important state changes lacked event emissions.
Off-chain monitoring depended on emitted events.
Impact and Severity:

Monitoring and incident investigation become less reliable.
Indexers may not detect important contract changes.
Severity: Low (Observation in the report).
Attack Flow:

An administrator performs a state-changing operation.
The contract updates storage without emitting an event.
Event-based monitoring does not see the change.
Monitoring and audit records become incomplete.
Resolved: Accepted, not fixed in the report. Hacken records the finding as accepted.

4.9 F-2024-6235 — Unused Function Parameters
Impact + root cause: Unused parameters make function behavior unclear.
Summary: The code contained function parameters that were not used. This can mislead callers and maintainers about what the function actually validates or does, but the report did not identify a direct exploit.

Root Cause:

One or more function parameters were unused.
The function interface suggested behavior that the implementation did not perform.
Impact and Severity:

Code review and maintenance become harder.
Callers may misunderstand the function's behavior.
Severity: Low (Observation in the report).
Attack Flow:

No direct attack flow was reported.
Resolved: Accepted, not fixed in the report. Hacken records the finding as accepted.

4.10 F-2024-6223 — Visibility of State Variable is Not Defined
Impact + root cause: Implicit visibility obscures state access.
Summary: A state variable did not declare its visibility explicitly. This is a code-quality issue that makes the intended access level less clear to developers and reviewers.

Root Cause:

A state variable omitted an explicit visibility modifier.
The code relied on Solidity's default visibility behavior.
Impact and Severity:

The intended access model is less clear.
Review and maintenance become harder.
Severity: Low (Observation in the report).
Attack Flow:

No direct attack flow was reported.
Resolved: Accepted, not fixed in the report. Hacken records the finding as accepted.

4.11 F-2024-6221 — Old Solidity Version May Result in Unsafe Code
Impact + root cause: Older compiler versions may lack important fixes.
Summary: The audit archive lists an additional low-severity observation about the Solidity compiler version. Older compiler versions may lack later compiler fixes or produce code that does not match the project's intended EVM targets. The detailed finding text was not exposed in the public indexed report.

Root Cause:

The source used a compiler version flagged by the audit index.
The public indexed finding does not expose the exact compiler range or affected line.
The report's broader compatibility note also warns about PUSH0 support across EVM chains.
Impact and Severity:

Compiler issues may affect correctness or deployment compatibility.
Unsupported opcodes can cause deployment or execution failures on some EVM networks.
Severity: Low (Observation in the audit index).
Attack Flow:

No specific exploit flow is available from the public indexed finding.
Resolved: Accepted / open in the public audit index. The indexed record lists the issue as an accepted observation. The exact required compiler upgrade or patch could not be confirmed from the public detail view.

5. Exploited vulnerability — HOT Bridge / NEAR Intents (30 September–1 October 2026)
This is a real incident, not a formal audit finding. It is included because it directly affected v2_1.omni.hot.tg and intents.near, and it is central to the bridge's security history.

Incident analysis: CertiK — HOT Bridge / NEAR Intents · BlockSec — NEAR Intents refund exploit

INC-2026-09-30 — Oversized refunds create unbacked internal balances
Impact + root cause: Failed refund accounting leaves unbacked token credits.
Summary: An attacker used a large pre-existing balance of an auxiliary token to request refunds far larger than a new deposit. The oversized refund event exceeded NEAR's 16,384-byte log limit, causing Intents' refund resolver to fail. HOT then returned the original backing while the earlier Intents credit survived. The attacker later withdrew approximately 3.865 million USDT from the BNB Chain treasury.

Root Cause:

The refund was capped by the requested amount and the receiver's current internal balance.
The calculation did not cap the refund by the amount deposited in the current transfer.
Earlier internal token balances could support oversized refund requests.
The refund event exceeded the NEAR log-size limit.
The deposit credit and refund resolution occurred in separate asynchronous receipts.
Failure of the later refund receipt did not undo the earlier successful credit receipt.
Impact and Severity:

Approximately 3.865 million USDT left the HOT BNB Chain treasury.
Intents recorded internal credits that were no longer backed by returned tokens.
Cross-contract accounting between HOT and Intents became inconsistent.
Severity: Crit (incident impact; not an auditor-assigned severity).
Attack Flow:

The attacker prefunded a malicious receiver with a large internal balance of an auxiliary token.
The attacker called HOT's mt_batch_transfer_call() with 97 small auxiliary-token entries and a USDT entry.
Intents' mt_on_transfer() path credited the malicious receiver before invoking its notification callback.
The malicious receiver returned 97 refund requests of 1e36 raw units and requested no USDT refund.
Intents attempted to resolve the oversized refunds and emit a large burn event.
The event exceeded the 16,384-byte log limit, so the refund-resolution receipt failed and its state changes rolled back.
HOT's mt_resolve_transfer() observed the failed promise and returned the original deposited tokens, including USDT.
The earlier Intents credit remained, creating unbacked internal balances.
The attacker repeated the process and later used normal withdrawal machinery to release USDT from the BNB Chain treasury.
Resolved: Core refund bug fixed; notification path later removed. On 2 October 2026, the refund calculation was changed to:

let refund_amount = requested_refund
    .min(*deposited)
    .min(balance_left);
This caps each refund by the requested amount, the amount deposited in the current transfer, and the receiver's available balance. The project also upgraded NEAR Intents to release 0.4.4 and reported recovery of affected funds. On 7 October 2026, deposit notifications were removed, closing the receiver-controlled refund path. The project also reported balance reconciliation and an automatic pause when internal balances do not match token holdings.

Important historical note: A January 2026 check of the initial deposit event's log length did not prevent this attack. The malicious receiver made the later refund/burn event too large; the vulnerable resolver did not enforce the current-deposit amount ceiling.

6. Separate researcher-reported issue — NEAR Omni Bridge
This is not one of the 41 formal audit findings and was not independently confirmed by the project in the public write-up. The repository is Near-One/omni-bridge, not HOT's hot-dao/hot-bridge.

Research report: Researcher disclosure — NEAR Omni Bridge refund-branch replay guard

RPT-NEAR-OMNI-001 — Refund branch removes finalized-transfer replay guard
Impact + root cause: Refund cleanup may reopen finalized transfer proofs.
Summary: The researcher claims that a refund branch removes a finalized-transfer record. If the record is removed after a receiver failure, the same proof may be submitted again while its other validity conditions remain satisfied. The write-up demonstrates the guard-removal path but does not complete an end-to-end economic impact test.

Root Cause:

fin_transfer_send_tokens_callback() handles receiver completion.
The refund branch may call remove_fin_transfer().
The finalized-transfer replay record may be removed.
The same proof may then appear unused to the replay check.
Impact and Severity:

A previously finalized transfer proof may be reusable.
Reuse could cause a duplicate transfer if all other checks pass.
The public report does not prove a successful funds-loss exploit.
Severity: Not independently rated; do not assign a confirmed severity.
Attack Flow:

A transfer is finalized and its proof is recorded.
The receiver callback fails or requests a refund.
The refund branch removes the finalized-transfer record.
The researcher resubmits the same transfer proof.
If no separate freshness check blocks it, the proof may be processed again.
Resolved: Unverified. The public researcher write-up does not establish a project-confirmed fix. The author states that previously published audit reports did not discuss the identified functions. Verify the current Near-One/omni-bridge code before relying on this claim.

7. Audit observations and risks not counted as formal findings
These items were explicitly mentioned in audit report risk sections but were not included in the formal finding totals above.

7.1 NEAR Intents — Hacken potential risks
Unpaid storage growth: Token onboarding can allocate storage without an initial user storage deposit. This is related to F-2025-8345 but was also stated as a broader design risk.
DAO centralization: The DAO can upgrade the contract, manage keys, and withdraw funds to arbitrary destinations. This is a privileged-role and governance risk.
Callback failure and locked funds: Asynchronous token callbacks can fail or consume unexpected gas. A failed withdrawal callback may leave funds locked; the report recommends simulation and sufficient gas.
Redundant signed JSON fields: A signed JSON payload can contain extra fields ignored by the contract, potentially confusing users about what they authorized.
7.2 HOT EVM wallet — Hacken potential risks
Nonce generation and integer division: Deposit nonces are generated on-chain, while withdrawal nonces are generated off-chain. Dividing by NONCE_TS_SHIFT can truncate values and may produce zero or unexpected nonce values if the generator is not careful.
Out-of-scope withdrawal refund: Expired-withdrawal refund handling was outside the audit scope.
Owner withdrawal power: withdrawToken() and withdrawEth() allow the owner to withdraw assets from the contract.
Centralized off-chain dependencies: Cross-chain communication and fund handling rely heavily on off-chain processes outside the audited contracts.
EVM opcode compatibility: Solidity 0.8.20+ may compile to use PUSH0; chains without support may fail to deploy or execute the bytecode.
Unbounded msg.value: Payable deposit() and withdraw() functions accept msg.value without a mechanism to validate or cap the fee.
8. Coverage notes and exclusions
The 2025 Veridise report covers the Rust HOT NEAR Bridge / OmniBalance contract, Rust Validation SDK, and Rust Stellar Locker. It does not prove that every currently deployed account or later commit was covered.
The 2024 Hacken HOT Omni Token report covers Solidity MetaWallet.sol and RlpEncode.sol. It is not an audit of the Rust NEP-245 contract deployed as v2_1.omni.hot.tg.
The public HOT audit reports reviewed here do not establish a separate audit specifically mapped to bridge-refuel.hot.tg. Do not assume the Veridise OmniBalance review audited that account's separate source code.
Guvenkaya also published a separate NEAR Intents Passkeys pull-request review. It is not included in the 41-finding total because the individual finding details were not verified in this research pass.
The two public GitHub issues concerning confidential swaps were not counted as confirmed smart-contract vulnerabilities. They describe disputed behavior in the confidential-swap pipeline and require project-side investigation.
The separate NEAR Omni Bridge replay report is a researcher claim against a different repository and is not included in the formal audit total.
9. Status summary
Source	Findings	Fixed	Mitigated	Accepted	Scheduled	Not fixed	Confirming fix	Acknowledged, no code fix
Hacken — NEAR Intents (2025)	5	2	1	2	0	0	0	0
Guvenkaya — NEAR Intents (2025)	4	0	0	0	1	3	0	0
Veridise — HOT Bridge (2025)	21	18	0	0	0	0	2	1
Hacken — HOT EVM wallet (2024)	11	4	0	7	0	0	0	0
Total	41	24	1	9	1	3	2	1
Status caution: Veridise's executive summary says 18 of 21 findings were fixed. For V-HOTB-VUL-009, V-HOTB-VUL-012, and Stellar Locker VUL-003, the summary/detail wording is inconsistent: the findings tables mark them fixed, while the detailed developer-response text says the issue was not acknowledged. Those entries are flagged individually above rather than silently treating the report as internally consistent.

10. Primary sources
Hacken — NEAR Intents / Defuse Contracts, 27 January 2025
Guvenkaya — NEAR Intents Security Review
Guvenkaya public reports repository
Veridise — HOT Bridge Audit PDF, 1 September 2025
Hacken — HOT Wallet / Hot Omni Token, 9 October 2024
CertiK — HOT Bridge / NEAR Intents incident analysis, 8 October 2026
BlockSec — NEAR Intents refund exploit analysis
HOT NEAR Bridge source
HOT Validation SDK source
HOT Stellar Bridge source
HOT EVM wallet source
NEAR Intents source




