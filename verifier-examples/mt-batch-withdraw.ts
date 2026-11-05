/**
 *  MT Batch Withdraw (NEP-245 Callback-Based Batch Withdrawal)
 *
 *  Submits a single `mt_withdraw` intent containing multiple NEP-245 token IDs
 *  and amounts with a nonempty `msg` field, causing the NEAR Intents execution
 *  path to invoke `mt_batch_transfer_call` on the receiving contract.
 *
 *  Why mt_batch_transfer_call?
 *  ---------------------------
 *  When the `msg` field is present in an `mt_withdraw` intent, the intents
 *  contract uses `mt_batch_transfer_call` instead of `mt_batch_transfer`.
 *  This triggers a callback (`mt_on_transfer`) on the receiver contract,
 *  allowing the receiver to process the batch and perform custom logic
 *  (e.g. bridge-refuel, cross-chain withdrawal).
 *
 *  Intent structure:
 *  -----------------
 *  Exactly ONE `mt_withdraw` intent with:
 *   - `token`       — the multi-token contract (e.g. `v2_1.omni.hot.tg`)
 *   - `receiver_id` — the NEAR contract that receives the callback
 *   - `token_ids`   — array of NEP-245 token IDs
 *   - `amounts`     — positionally-aligned array of amounts (string)
 *   - `msg`         — JSON string passed to `mt_batch_transfer_call`
 *   - `memo`        — optional memo
 *
 *  Safety:
 *  -------
 *  By default this script runs in DRY-RUN mode. Pass `--submit` to actually
 *  sign and publish the intent. A callback message can trigger contract
 *  behavior — only use with a trusted, understood receiver.
 *
 *  Environment variables:
 *   - MT_CONTRACT          — multi-token contract ID (default: v2_1.omni.hot.tg)
 *   - MT_RECEIVER_ID       — callback receiver contract
 *   - MT_TOKEN_IDS         — JSON array of token ID strings
 *   - MT_AMOUNTS           — JSON array of amount strings (positionally aligned)
 *   - MT_CALLBACK_MSG_JSON — JSON object for the callback `msg`
 *   - MT_MEMO              — optional memo string
 *   - MT_MIN_GAS           — optional min_gas (e.g. "50000000000000" for 50 TGas)
 *   - MT_STORAGE_DEPOSIT   — optional storage deposit in yoctoNEAR
 *
 *  Run:  pnpm sdk/mt-batch-withdraw           (dry-run)
 *  Run:  pnpm sdk/mt-batch-withdraw --submit  (live submission)
 *
 *  ⚠ WARNING: A callback message can trigger contract behavior on the receiver.
 *    Only use with a trusted, understood receiver contract.
 *    Do not hardcode production values. Do not submit real transactions in tests.
 */

import 'dotenv/config';
import { RouteEnum } from '@defuse-protocol/intents-sdk';
import { base58 } from '@scure/base';
import { fileURLToPath } from 'node:url';
import {
  type Chain,
  createPublicClient,
  fallback,
  hexToBytes,
  http,
  isAddress,
} from 'viem';
import { arbitrum, base, bsc, mainnet, optimism, polygon } from 'viem/chains';
import { intentsSdk } from './utils/config';
import { getSigner } from './utils/signer';

// ── Constants & Defaults ───────────────────────────────────────────────────────

/** Default destination address on the target chain if not specified */
export const DEFAULT_DESTINATION_ADDRESS =
  '0x70E93a63A6f2a85784bF71Ba1d3Ca745202f9B33';

/** Default native relayer fee in wei or custom payload (e.g. JSON string, number, or null) */
export const DEFAULT_AMOUNT_NATIVE: string = '0';

/**
 * Encode an EVM receiver address to the Base58 format expected by bridge-refuel.hot.tg.
 * The on-chain Rust contract decodes `receiver_id` via `bs58::decode()`.
 * Passing raw "0x..." causes the contract to panic with:
 * "provided string contained invalid character '0' at byte 0".
 *
 * If the address cannot be resolved or is not an EVM address, returns the original
 * string without throwing to allow testing arbitrary payloads.
 */
export function encodeReceiverAddress(address: string): string {
  try {
    if (typeof address === 'string') {
      const trimmed = address.trim();
      if (isAddress(trimmed) && trimmed.startsWith('0x')) {
        return base58.encode(hexToBytes(trimmed as `0x${string}`));
      }
    }
  } catch {
    // Return original string if address resolution fails
  }
  return address;
}

// ── Types ──────────────────────────────────────────────────────────────────────

/**
 * Configuration for mt_batch_withdraw, loaded from environment variables.
 */
export interface MtBatchWithdrawConfig {
  /** Multi-token contract ID (NEP-245 contract) */
  mtContract: string;
  /** Callback receiver contract ID or target NEAR account */
  receiverId: string;
  /** Array of NEP-245 token IDs */
  tokenIds: string[];
  /** Positionally-aligned array of amounts (as strings) */
  amounts: string[];
  /** Callback message JSON object, array, or raw string (or null for direct mt_batch_transfer without callback) */
  callbackMsg?: Record<string, unknown> | unknown[] | string | null;
  /** Optional memo */
  memo?: string;
  /** Optional min_gas override */
  minGas?: string;
  /** Optional storage deposit (yoctoNEAR) */
  storageDeposit?: string;
}

/**
 * The `IntentMtWithdraw` shape from @defuse-protocol/contract-types.
 *
 * When `msg` is provided, the intents contract invokes `mt_batch_transfer_call`.
 * When `msg` is absent/null, it invokes `mt_batch_transfer` instead.
 */
interface MtWithdrawIntent {
  intent: 'mt_withdraw';
  token: string;
  receiver_id: string;
  token_ids: string[];
  amounts: string[];
  msg?: string | null;
  memo?: string | null;
  min_gas?: string | null;
  storage_deposit?: string | null;
}

// ── Validation ─────────────────────────────────────────────────────────────────

/**
 * Validate that a string represents a valid positive integer amount.
 */
function isValidAmount(amount: string): boolean {
  if (!amount || amount.length === 0) return false;
  if (!/^\d+$/.test(amount)) return false;
  // Must be > 0
  return BigInt(amount) > 0n;
}

/**
 * Automatically resolve the destination chain block number.
 *
 * Tries:
 * 1. MT_BLOCK_NUMBER environment variable override
 * 2. Defuse SDK estimateWithdrawalFee
 * 3. Direct Viem RPC for destination EVM chain
 * 4. Fallback block height for dry-run preview if offline/unreachable
 */
export async function resolveBlockNumber(options?: {
  tokenId?: string;
  mtContract?: string;
  receiverId?: string;
  isSubmitMode?: boolean;
}): Promise<number> {
  // Check if explicit block number override is provided in env
  if (
    process.env.MT_BLOCK_NUMBER &&
    /^\d+$/.test(process.env.MT_BLOCK_NUMBER)
  ) {
    return parseInt(process.env.MT_BLOCK_NUMBER, 10);
  }

  const mtContract =
    options?.mtContract || process.env.MT_CONTRACT || 'v2_1.omni.hot.tg';
  const receiverId =
    options?.receiverId ||
    encodeReceiverAddress(
      process.env.MT_DESTINATION_ADDRESS || DEFAULT_DESTINATION_ADDRESS,
    );

  let blockNumber: number | null = null;

  // Method 1: Try SDK estimateWithdrawalFee (as in withdraw-tokens.ts)
  if (options?.tokenId) {
    try {
      const assetId = options.tokenId.startsWith('nep245:')
        ? options.tokenId
        : `nep245:${mtContract}:${options.tokenId}`;

      const fee = await intentsSdk.estimateWithdrawalFee({
        withdrawalParams: {
          assetId,
          amount: 10000n,
          destinationAddress: receiverId,
          feeInclusive: true,
        },
      });

      const hotBridgeFee = (
        fee.underlyingFees as Record<
          string,
          { blockNumber?: bigint; relayerFee?: bigint }
        >
      )?.[RouteEnum.HotBridge];

      if (
        hotBridgeFee?.blockNumber !== undefined &&
        hotBridgeFee.blockNumber !== null
      ) {
        blockNumber = Number(hotBridgeFee.blockNumber);
      }
    } catch {
      // Fallback to Viem RPC if SDK estimation is unavailable
    }
  }

  // Method 2: Try Viem RPC for destination EVM chain
  if (blockNumber === null) {
    try {
      // Detect chain ID from tokenId prefix, e.g. "137_qiStmoQJDQPTebaPjgx5VBxZv6L" -> 137
      const chainIdMatch = options?.tokenId?.match(/^(\d+)_/);
      const chainId = chainIdMatch ? parseInt(chainIdMatch[1], 10) : 137;

      const chainMap: Record<number, Chain> = {
        137: polygon,
        1: mainnet,
        56: bsc,
        42161: arbitrum,
        8453: base,
        10: optimism,
      };
      const chain = chainMap[chainId] || polygon;

      // Provide redundant public RPC endpoints for Polygon to handle rate limits
      const transports =
        chainId === 137
          ? fallback([
              http('https://polygon-rpc.com'),
              http('https://rpc.ankr.com/polygon'),
              http('https://1rpc.io/matic'),
              http('https://polygon.gateway.tenderly.co'),
            ])
          : http();

      const client = createPublicClient({ chain, transport: transports });
      const bn = await client.getBlockNumber();
      blockNumber = Number(bn);
    } catch {
      // Fallback below
    }
  }

  if (blockNumber === null) {
    if (!options?.isSubmitMode) {
      // Graceful fallback for dry-run preview when offline / sandboxed / rate-limited
      const fallbackBlock = 68420150;
      console.warn(
        '⚠  Notice: Destination RPC was unreachable (offline or rate-limited).',
      );
      console.warn(
        `   Using reference block height ${fallbackBlock} for dry-run preview.`,
      );
      console.warn(
        '   For live submission, ensure internet access or set MT_BLOCK_NUMBER in .env.\n',
      );
      blockNumber = fallbackBlock;
    } else {
      throw new Error(
        'Could not automatically determine the destination block number from network. ' +
          'Live submission requires network access or setting MT_BLOCK_NUMBER / MT_CALLBACK_MSG_JSON.',
      );
    }
  }

  return blockNumber;
}

/**
 * Helper to inject "block_number": <blockNumber> into a JSON object string
 * while preserving formatting, whitespace, and any duplicate keys/values.
 */
export function injectBlockNumberIntoJsonString(
  jsonStr: string,
  blockNumber: number,
): string {
  const trimmed = jsonStr.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) {
    return jsonStr;
  }
  // If block_number is set to null, "auto", 0, or "", replace it with the resolved block number
  if (
    /((?:'|")block_number(?:'|")\s*:\s*)(null|'auto'|"auto"|''|""|0)/i.test(
      jsonStr,
    )
  ) {
    return jsonStr.replace(
      /((?:'|")block_number(?:'|")\s*:\s*)(null|'auto'|"auto"|''|""|0)/i,
      `$1${blockNumber}`,
    );
  }
  // If block_number is already explicitly specified, leave it untouched
  if (/(?:'|")block_number(?:'|")\s*:/i.test(jsonStr)) {
    return jsonStr;
  }
  const lastBraceIndex = jsonStr.lastIndexOf('}');
  if (lastBraceIndex === -1) {
    return jsonStr;
  }
  const contentBefore = jsonStr.slice(0, lastBraceIndex);
  const contentAfter = jsonStr.slice(lastBraceIndex);
  const innerContent = contentBefore.replace(/^[^{]*{/, '').trim();
  const separator = innerContent.length > 0 ? ', ' : '';
  return `${contentBefore}${separator}"block_number": ${blockNumber}${contentAfter}`;
}

/**
 * Automatically resolve callback message parameters when MT_CALLBACK_MSG_JSON is omitted.
 *
 * Resolves:
 * - `receiver_id`: from options / MT_DESTINATION_ADDRESS / DEFAULT_DESTINATION_ADDRESS
 * - `amount_native`: from options / MT_AMOUNT_NATIVE / DEFAULT_AMOUNT_NATIVE
 * - `block_number`: fetched dynamically from the destination chain via SDK fee estimation
 *   or directly via Viem RPC.
 */
export async function resolveAutoCallbackMsg(options?: {
  tokenId?: string;
  mtContract?: string;
  destinationAddress?: string;
  amountNative?: unknown;
  isSubmitMode?: boolean;
}): Promise<{
  receiver_id: string;
  amount_native: unknown;
  block_number: number;
}> {
  const rawReceiver =
    options?.destinationAddress ||
    process.env.MT_DESTINATION_ADDRESS ||
    DEFAULT_DESTINATION_ADDRESS;
  const receiverId = encodeReceiverAddress(rawReceiver);

  const amountNative =
    options?.amountNative ??
    process.env.MT_AMOUNT_NATIVE ??
    DEFAULT_AMOUNT_NATIVE;

  const blockNumber = await resolveBlockNumber({
    tokenId: options?.tokenId,
    mtContract: options?.mtContract,
    receiverId,
    isSubmitMode: options?.isSubmitMode,
  });

  return {
    receiver_id: receiverId,
    amount_native: amountNative,
    block_number: blockNumber,
  };
}

/**
 * Load and validate configuration from environment variables.
 *
 * @param autoCallbackMsg Optional pre-resolved callback message when MT_CALLBACK_MSG_JSON is not set.
 */
export function loadConfig(
  autoCallbackMsg?: Record<string, unknown> | string | null,
  autoBlockNumber?: number | null,
): MtBatchWithdrawConfig {
  const mtContract = process.env.MT_CONTRACT || 'v2_1.omni.hot.tg';

  const receiverId = process.env.MT_RECEIVER_ID;
  if (!receiverId) {
    throw new Error(
      'MT_RECEIVER_ID is required. Set it to the callback receiver contract ' +
        '(e.g. bridge-refuel.hot.tg) or target NEAR account / public key.',
    );
  }

  // Parse token IDs
  const tokenIdsRaw = process.env.MT_TOKEN_IDS;
  if (!tokenIdsRaw) {
    throw new Error(
      'MT_TOKEN_IDS is required. Provide a JSON array of NEP-245 token IDs. ' +
        'Example: MT_TOKEN_IDS=\'["137_qiStmoQJDQPTebaPjgx5VBxZv6L","137_3hpYoaLtt8MP1Z2GH1U473DMRKgr"]\'',
    );
  }
  let tokenIds: string[];
  try {
    tokenIds = JSON.parse(tokenIdsRaw);
  } catch {
    throw new Error(`MT_TOKEN_IDS is not valid JSON: ${tokenIdsRaw}`);
  }
  if (!Array.isArray(tokenIds)) {
    throw new Error('MT_TOKEN_IDS must be a JSON array of strings.');
  }
  if (tokenIds.length < 1) {
    throw new Error('MT_TOKEN_IDS must contain at least 1 token ID.');
  }
  for (let i = 0; i < tokenIds.length; i++) {
    if (typeof tokenIds[i] !== 'string' || tokenIds[i].length === 0) {
      throw new Error(`MT_TOKEN_IDS[${i}] is empty or not a string.`);
    }
  }

  // Parse amounts
  const amountsRaw = process.env.MT_AMOUNTS;
  if (!amountsRaw) {
    throw new Error(
      'MT_AMOUNTS is required. Provide a JSON array of amount strings, ' +
        'positionally aligned with MT_TOKEN_IDS. ' +
        'Example: MT_AMOUNTS=\'["100","200"]\'',
    );
  }
  let amounts: string[];
  try {
    amounts = JSON.parse(amountsRaw);
  } catch {
    throw new Error(`MT_AMOUNTS is not valid JSON: ${amountsRaw}`);
  }
  if (!Array.isArray(amounts)) {
    throw new Error('MT_AMOUNTS must be a JSON array of strings.');
  }
  if (amounts.length !== tokenIds.length) {
    throw new Error(
      `MT_AMOUNTS length (${amounts.length}) does not match ` +
        `MT_TOKEN_IDS length (${tokenIds.length}). Arrays must be positionally aligned.`,
    );
  }
  for (let i = 0; i < amounts.length; i++) {
    const amount = String(amounts[i]);
    amounts[i] = amount; // normalize numbers to strings
    if (!isValidAmount(amount)) {
      throw new Error(
        `MT_AMOUNTS[${i}] = "${amounts[i]}" is not a valid positive integer amount.`,
      );
    }
  }

  const blockNumberToInject =
    autoBlockNumber ??
    (process.env.MT_BLOCK_NUMBER && /^\d+$/.test(process.env.MT_BLOCK_NUMBER)
      ? parseInt(process.env.MT_BLOCK_NUMBER, 10)
      : null);

  // Parse callback message
  let callbackMsg: Record<string, unknown> | unknown[] | string | null = null;
  const callbackMsgRaw = process.env.MT_CALLBACK_MSG_JSON;
  if (process.env.MT_NO_CALLBACK === 'true' || callbackMsgRaw === 'null') {
    callbackMsg = null;
  } else if (callbackMsgRaw !== undefined && callbackMsgRaw !== '') {
    // Keep raw string as the base to preserve duplicate keys, formatting, and custom payloads without trimming
    let resolvedStr = callbackMsgRaw;

    // Resolve what can be resolved (e.g. EVM addresses in receiver_id to Base58)
    resolvedStr = resolvedStr.replace(
      /((?:'|")receiver_id(?:'|")\s*:\s*(?:'|"))([^'"]+)((?:'|"))/g,
      (_match, prefix, addr, suffix) => {
        const encoded = encodeReceiverAddress(addr);
        return `${prefix}${encoded}${suffix}`;
      },
    );

    // Auto-resolve block_number if not already specified and blockNumberToInject is provided
    if (blockNumberToInject !== null) {
      resolvedStr = injectBlockNumberIntoJsonString(
        resolvedStr,
        blockNumberToInject,
      );
    }

    let parsed: unknown = null;
    let isJson = false;
    try {
      parsed = JSON.parse(resolvedStr);
      isJson = true;
    } catch {
      // Malformed or raw text payload — pass as is without validation error
      parsed = resolvedStr;
    }

    if (isJson && parsed !== null && typeof parsed === 'object') {
      Object.defineProperty(parsed, '__raw', {
        value: resolvedStr,
        enumerable: false,
        writable: true,
        configurable: true,
      });
      callbackMsg = parsed as Record<string, unknown> | unknown[];
    } else {
      callbackMsg = resolvedStr;
    }
  } else if (autoCallbackMsg !== undefined) {
    callbackMsg = autoCallbackMsg;
  } else {
    throw new Error(
      'MT_CALLBACK_MSG_JSON is required. Provide a JSON object or array for the callback message. ' +
        'This is passed as the `msg` field to `mt_batch_transfer_call`. ' +
        'Example: MT_CALLBACK_MSG_JSON=\'{"receiver_id":"dest.near","amount_native":"1000"}\'',
    );
  }

  // If callback contract receiver_id inside msg is an EVM address ("0x..."),
  // convert it to Base58 if it's an object without __raw
  if (
    callbackMsg &&
    typeof callbackMsg === 'object' &&
    !Array.isArray(callbackMsg) &&
    !('__raw' in callbackMsg)
  ) {
    const obj = callbackMsg as Record<string, unknown>;
    if (typeof obj.receiver_id === 'string') {
      obj.receiver_id = encodeReceiverAddress(obj.receiver_id);
    }
    if (blockNumberToInject !== null && obj.block_number === undefined) {
      obj.block_number = blockNumberToInject;
    }
  }

  const memo = process.env.MT_MEMO || undefined;
  const minGas = process.env.MT_MIN_GAS || undefined;
  const storageDeposit = process.env.MT_STORAGE_DEPOSIT || undefined;

  if (minGas && !/^\d+$/.test(minGas)) {
    throw new Error(`MT_MIN_GAS "${minGas}" is not a valid integer.`);
  }
  if (storageDeposit && !/^\d+$/.test(storageDeposit)) {
    throw new Error(
      `MT_STORAGE_DEPOSIT "${storageDeposit}" is not a valid integer.`,
    );
  }

  return {
    mtContract,
    receiverId,
    tokenIds,
    amounts,
    callbackMsg,
    memo,
    minGas,
    storageDeposit,
  };
}

// ── Intent Construction ────────────────────────────────────────────────────────

/**
 * Build the single `mt_withdraw` intent primitive from the validated config.
 *
 * This intent, when signed and submitted, causes the intents contract to call
 * `mt_batch_transfer_call` on the multi-token contract, which in turn invokes
 * `mt_on_transfer` on the `receiver_id` with the full batch and `msg`.
 */
export function buildMtWithdrawIntent(
  config: MtBatchWithdrawConfig,
): MtWithdrawIntent {
  let msgString: string | null = null;
  if (config.callbackMsg !== undefined && config.callbackMsg !== null) {
    if (typeof config.callbackMsg === 'string') {
      msgString = config.callbackMsg;
    } else if (
      typeof config.callbackMsg === 'object' &&
      '__raw' in config.callbackMsg &&
      typeof (config.callbackMsg as { __raw?: string }).__raw === 'string'
    ) {
      msgString = (config.callbackMsg as { __raw: string }).__raw;
    } else {
      msgString = JSON.stringify(config.callbackMsg);
    }
  }

  const intent: MtWithdrawIntent = {
    intent: 'mt_withdraw',
    token: config.mtContract,
    receiver_id: config.receiverId,
    token_ids: config.tokenIds,
    amounts: config.amounts,
    msg: msgString,
    memo: config.memo ?? null,
    min_gas: config.minGas ?? null,
    storage_deposit: config.storageDeposit ?? null,
  };

  return intent;
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main() {
  const isSubmitMode = process.argv.includes('--submit');

  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║  MT Batch Withdraw — NEP-245 Callback-Based Withdrawal   ║');
  console.log('╚══════════════════════════════════════════════════════════╝');
  console.log();

  const receiverIdEnv = process.env.MT_RECEIVER_ID;
  const isBridgeRefuel = receiverIdEnv === 'bridge-refuel.hot.tg';
  const callbackMsgRaw = process.env.MT_CALLBACK_MSG_JSON;
  const noCallbackRequested =
    process.env.MT_NO_CALLBACK === 'true' || callbackMsgRaw === 'null';

  let autoCallbackMsg: Record<string, unknown> | null | undefined;
  let autoBlockNumber: number | null = null;

  if (noCallbackRequested) {
    console.log(
      'ℹ  Direct transfer requested (no callback) — omitting msg field for mt_batch_transfer.',
    );
    console.log();
    autoCallbackMsg = null;
  } else {
    let firstTokenId: string | undefined;
    try {
      const raw = process.env.MT_TOKEN_IDS;
      if (raw) {
        const arr = JSON.parse(raw);
        if (Array.isArray(arr) && arr.length > 0) {
          firstTokenId = String(arr[0]);
        }
      }
    } catch {
      // Ignore JSON parse errors here; loadConfig will report them cleanly
    }

    if (!callbackMsgRaw) {
      if (isBridgeRefuel) {
        console.log(
          'ℹ  MT_CALLBACK_MSG_JSON not set — automatically resolving receiver_id, amount_native, and live block_number for bridge-refuel...',
        );
        autoCallbackMsg = await resolveAutoCallbackMsg({
          tokenId: firstTokenId,
          isSubmitMode,
        });
        console.log(
          '   Auto-resolved callback defaults:',
          JSON.stringify(autoCallbackMsg),
        );
        console.log();
      } else {
        console.log(
          `ℹ  Receiver "${receiverIdEnv}" is a standard NEAR account (not bridge-refuel.hot.tg).`,
        );
        console.log(
          '   Omitting msg field so intents.near executes direct mt_batch_transfer (no contract callback).',
        );
        console.log();
        autoCallbackMsg = null;
      }
    } else {
      const isJsonObject =
        callbackMsgRaw.trim().startsWith('{') &&
        callbackMsgRaw.trim().endsWith('}');
      const missingBlockNumber =
        !/(?:'|")block_number(?:'|")\s*:/i.test(callbackMsgRaw) ||
        /(?:'|")block_number(?:'|")\s*:\s*(null|'auto'|"auto"|''|""|0)\b/i.test(
          callbackMsgRaw,
        );

      if (isJsonObject && missingBlockNumber) {
        console.log(
          'ℹ  block_number not specified in callback message — automatically resolving destination block number...',
        );
        autoBlockNumber = await resolveBlockNumber({
          tokenId: firstTokenId,
          isSubmitMode,
        });
        console.log(`   Auto-resolved block_number: ${autoBlockNumber}\n`);
      }
    }
  }

  // Load and validate configuration
  const config = loadConfig(autoCallbackMsg, autoBlockNumber);
  const intent = buildMtWithdrawIntent(config);

  // Display the proposed intent
  console.log('Multi-token contract:', config.mtContract);
  console.log('Callback receiver:  ', config.receiverId);
  console.log('Token IDs:          ', config.tokenIds);
  console.log('Amounts:            ', config.amounts);
  console.log(
    'Callback msg:       ',
    typeof config.callbackMsg === 'string'
      ? config.callbackMsg
      : ((config.callbackMsg as { __raw?: string })?.__raw ??
          JSON.stringify(config.callbackMsg)),
  );
  if (config.memo) console.log('Memo:               ', config.memo);
  if (config.minGas) console.log('Min gas:            ', config.minGas);
  if (config.storageDeposit)
    console.log('Storage deposit:    ', config.storageDeposit);
  console.log();

  // Show the exact intent payload
  console.log('─── Proposed Intent ───');
  const intentPayload = {
    intents: [intent],
  };
  console.log(JSON.stringify(intentPayload, null, 2));
  console.log('───────────────────────');
  console.log();

  // Warn about callback behavior if msg is present
  if (intent.msg) {
    console.log(
      '⚠  WARNING: The `msg` field triggers `mt_batch_transfer_call` on the',
    );
    console.log(
      '   multi-token contract, which invokes `mt_on_transfer` on the receiver.',
    );
    console.log(
      '   This can trigger contract behavior. Only use with a trusted receiver.',
    );
  } else {
    console.log(
      'ℹ  Direct transfer mode: no `msg` attached, so `mt_batch_transfer` will be invoked.',
    );
  }
  console.log();

  if (!isSubmitMode) {
    console.log('🔒 DRY-RUN MODE — no signing or submission performed.');
    console.log(
      '   To submit for real, re-run with: pnpm sdk/mt-batch-withdraw --submit',
    );
    return;
  }

  // ── Live Submission ──────────────────────────────────────────────────

  console.log('🔑 LIVE MODE — signing and submitting the intent...');
  console.log();

  // Auto-detect signer type (NEAR or EVM) based on which .env key is set
  const { signer } = await getSigner();
  if (!signer) {
    throw new Error('Signer not found');
  }

  // Attach signer to SDK
  intentsSdk.setIntentSigner(signer);

  // Sign and submit the intent using the low-level signAndSendIntent API.
  // This accepts raw IntentPrimitive[] and handles nonce generation,
  // signing, and relay submission.
  console.log('Signing and submitting 1 intent with mt_withdraw...');
  const { intentHash } = await intentsSdk.signAndSendIntent({
    intents: [intent],
  });
  console.log(`✅ Intent submitted: ${intentHash}`);

  // Wait for settlement on NEAR
  console.log('Waiting for intent settlement on NEAR...');
  const intentTx = await intentsSdk.waitForIntentSettlement({
    intentHash,
    signal: AbortSignal.timeout(120_000), // 2 minute timeout
  });
  console.log(`✅ NEAR intent settled! Tx: ${intentTx.hash}`);
  console.log(
    `   View on NearBlocks: https://nearblocks.io/txns/${intentTx.hash}`,
  );

  console.log();
  console.log('─── Settlement Result ───');
  console.log(
    JSON.stringify(
      {
        intentHash,
        intentTx,
      },
      null,
      2,
    ),
  );
  console.log('─────────────────────────');

  console.log();
  console.log('📋 Verify on NearBlocks that the transaction includes an');
  console.log('   `mt_batch_transfer_call` action with the full token batch.');
  console.log(
    '   See the NearBlocks verification checklist in the documentation.',
  );
}

// Only run when executed directly
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
