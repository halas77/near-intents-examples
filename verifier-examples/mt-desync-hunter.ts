import 'dotenv/config';
import { fileURLToPath } from 'node:url';
import { writeFile } from 'node:fs/promises';
import { hexToBytes, isAddress } from 'viem';
import { base58 } from '@scure/base';
import { intentsSdk } from './utils/config';
import { getSigner } from './utils/signer';

type UnknownObject = Record<string, unknown>;

interface MtWithdrawIntent {
  intent: 'mt_withdraw';
  token: string;
  receiver_id: string;
  token_ids: string[];
  amounts: string[];
  msg: string;
  memo: string | null;
  min_gas: string | null;
  storage_deposit: string | null;
}

interface TxOutcome {
  result: {
    receipts_outcome: Array<{
      id: string;
      outcome: {
        executor_id: string;
        logs: string[];
        status: {
          SuccessValue?: string;
          SuccessReceiptId?: string;
          Failure?: unknown;
        };
      };
    }>;
  };
}

interface LegTrace {
  memo: string;
  transferReceiptId: string;
  bridgeReceiptId?: string;
  unused?: string[];
  unused0?: string;
  nonZeroUnused0: boolean;
}

interface CaseResult {
  name: string;
  intentHash?: string;
  txHash?: string;
  signerAccountId?: string;
  mtOnTransferUnused?: string[];
  mtOnTransferUnusedAll?: string[][];
  bridgeSuccessDecoded?: string[];
  legTraces?: LegTrace[];
  correlatedLikelyDesync?: boolean;
  callbackErrorObserved?: boolean;
  panicOrErrorObserved?: boolean;
  withdrawContinuedAfterError?: boolean;
  failureReceipts?: string[];
  withdrawStarted: boolean;
  refundApplied: boolean;
  likelyDesync: boolean;
  note: string;
}

interface ExecutionSignals {
  callbackErrorObserved: boolean;
  panicOrErrorObserved: boolean;
  failureReceipts: string[];
}

interface HunterCaseIntent {
  name?: string;
  msgObject?: UnknownObject;
  rawMsg?: string;
  tokenIds?: string[];
  amounts?: string[];
  memo?: string | null;
  minGas?: string;
}

interface HunterCase {
  name: string;
  msgObject?: UnknownObject;
  rawMsg?: string;
  intents?: HunterCaseIntent[];
}

const DEFAULT_MT_CONTRACT = process.env.MT_CONTRACT || 'v2_1.omni.hot.tg';
const DEFAULT_RECEIVER = process.env.MT_RECEIVER_ID || 'bridge-refuel.hot.tg';
const DEFAULT_MIN_GAS = process.env.MT_MIN_GAS || '1000';

const DEFAULT_TOKEN_IDS = [
  '137_qiStmoQJDQPTebaPjgx5VBxZv6L',
  '56_2w93GqMcEmQFDru84j3HZZWt557r',
];

const DEFAULT_AMOUNTS = ['2000', '1000000000000000'];

const BASE_RECEIVER_HEX =
  process.env.MT_DESTINATION_ADDRESS ||
  '0x70E93a63A6f2a85784bF71Ba1d3Ca745202f9B33';

function encodeReceiverAddress(address: string): string {
  if (isAddress(address) && address.startsWith('0x')) {
    return base58.encode(hexToBytes(address as `0x${string}`));
  }
  return address;
}

function parseArrayEnv(key: string, fallback: string[]): string[] {
  const raw = process.env[key];
  if (!raw) return fallback;
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed) || parsed.some((v) => typeof v !== 'string')) {
    throw new Error(`${key} must be JSON string array`);
  }
  return parsed;
}

function decodeSuccessValueBase64(successValue?: string): string {
  if (!successValue) return '';
  if (successValue.length === 0) return '';
  try {
    return Buffer.from(successValue, 'base64').toString('utf8');
  } catch {
    return '';
  }
}

async function fetchTxOutcome(
  txHash: string,
  accountId: string,
): Promise<TxOutcome> {
  const res = await fetch('https://rpc.mainnet.near.org', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 'desync-hunter',
      method: 'tx',
      params: [txHash, accountId],
    }),
  });
  const json = (await res.json()) as TxOutcome | { error: unknown };
  if ('error' in json) {
    throw new Error(`RPC tx query failed for ${txHash}`);
  }
  return json;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchTxOutcomeWithRetry(
  txHash: string,
  accountId: string,
  attempts = 4,
): Promise<TxOutcome> {
  let lastError: unknown;

  for (let i = 1; i <= attempts; i++) {
    try {
      return await fetchTxOutcome(txHash, accountId);
    } catch (error) {
      lastError = error;
      if (i < attempts) {
        await sleep(1200 * i);
      }
    }
  }

  throw new Error(
    `RPC tx query failed after ${attempts} attempts for ${txHash}: ${String(lastError)}`,
  );
}

function toNumericString(value: unknown): string | null {
  if (typeof value === 'string') {
    return /^\d+$/.test(value) ? value : null;
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) return null;
    return String(value);
  }
  return null;
}

function extractUnusedArraysFromParsed(
  value: unknown,
  path = '',
): Array<{ path: string; values: string[] }> {
  const found: Array<{ path: string; values: string[] }> = [];

  if (Array.isArray(value)) {
    const normalized = value.map((v) => toNumericString(v));
    if (normalized.every((v) => v !== null)) {
      found.push({ path: path || '$', values: normalized as string[] });
    }

    value.forEach((v, i) => {
      found.push(...extractUnusedArraysFromParsed(v, `${path}[${i}]`));
    });
    return found;
  }

  if (!value || typeof value !== 'object') {
    return found;
  }

  for (const [k, v] of Object.entries(value as UnknownObject)) {
    const nextPath = path ? `${path}.${k}` : k;
    const keyLooksRelevant = /unused|remain|refund/i.test(k);

    if (keyLooksRelevant && Array.isArray(v)) {
      const normalized = v.map((x) => toNumericString(x));
      if (normalized.every((x) => x !== null)) {
        found.push({ path: nextPath, values: normalized as string[] });
      }
    }

    found.push(...extractUnusedArraysFromParsed(v, nextPath));
  }

  return found;
}

function parseUnusedFromBridgeReceipts(outcome: TxOutcome): {
  unusedArrays: string[][];
  decodedSuccessValues: string[];
  bridgeUnusedByReceipt: Array<{
    receiptId: string;
    unusedArrays: string[][];
  }>;
} {
  const unusedArrays: string[][] = [];
  const decodedSuccessValues: string[] = [];
  const bridgeUnusedByReceipt: Array<{
    receiptId: string;
    unusedArrays: string[][];
  }> = [];

  for (const receipt of outcome.result.receipts_outcome) {
    if (receipt.outcome.executor_id !== 'bridge-refuel.hot.tg') continue;
    const decoded = decodeSuccessValueBase64(
      receipt.outcome.status.SuccessValue,
    );
    if (!decoded) continue;

    decodedSuccessValues.push(decoded);

    try {
      const parsed = JSON.parse(decoded);
      const extracted = extractUnusedArraysFromParsed(parsed)
        .filter((item) => item.values.length > 0)
        .map((item) => item.values);
      unusedArrays.push(...extracted);
      bridgeUnusedByReceipt.push({
        receiptId: receipt.id,
        unusedArrays: extracted,
      });
    } catch {
      // Ignore non-JSON success values.
      bridgeUnusedByReceipt.push({ receiptId: receipt.id, unusedArrays: [] });
    }
  }

  const unique = Array.from(
    new Set(unusedArrays.map((a) => JSON.stringify(a))),
  );

  return {
    unusedArrays: unique.map((s) => JSON.parse(s) as string[]),
    decodedSuccessValues,
    bridgeUnusedByReceipt,
  };
}

function parseEventJsonLog(log: string): UnknownObject | null {
  if (!log.startsWith('EVENT_JSON:')) return null;
  const payload = log.slice('EVENT_JSON:'.length);
  try {
    const parsed = JSON.parse(payload);
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed as UnknownObject;
  } catch {
    return null;
  }
}

function buildLegTraces(
  outcome: TxOutcome,
  receiverId: string,
  bridgeUnusedByReceipt: Array<{ receiptId: string; unusedArrays: string[][] }>,
): LegTrace[] {
  const transferLegs: Array<{ memo: string; transferReceiptId: string }> = [];

  for (const receipt of outcome.result.receipts_outcome) {
    if (receipt.outcome.executor_id !== 'v2_1.omni.hot.tg') continue;

    for (const log of receipt.outcome.logs) {
      const parsed = parseEventJsonLog(log);
      if (!parsed) continue;

      if (parsed.event !== 'mt_transfer' || !Array.isArray(parsed.data))
        continue;

      for (const item of parsed.data) {
        if (!item || typeof item !== 'object') continue;
        const row = item as UnknownObject;
        if (row.new_owner_id !== receiverId) continue;
        const memo = typeof row.memo === 'string' ? row.memo : '(no-memo)';
        transferLegs.push({ memo, transferReceiptId: receipt.id });
      }
    }
  }

  return transferLegs.map((leg, i) => {
    const bridge = bridgeUnusedByReceipt[i];
    const unused = bridge?.unusedArrays[0];
    const unused0 = unused?.[0] ?? '0';
    let nonZeroUnused0 = false;
    try {
      nonZeroUnused0 = BigInt(unused0) > 0n;
    } catch {
      nonZeroUnused0 = false;
    }

    return {
      memo: leg.memo,
      transferReceiptId: leg.transferReceiptId,
      bridgeReceiptId: bridge?.receiptId,
      unused,
      unused0,
      nonZeroUnused0,
    };
  });
}

function inspectExecutionSignals(
  outcome: TxOutcome,
  callbackExecutorId: string,
): ExecutionSignals {
  const failureReceipts: string[] = [];
  let callbackErrorObserved = false;
  let panicOrErrorObserved = false;

  for (const receipt of outcome.result.receipts_outcome) {
    const failure = receipt.outcome.status.Failure;
    const failureText = failure
      ? (JSON.stringify(failure) ?? String(failure))
      : '';
    if (failureText) {
      failureReceipts.push(
        `${receipt.outcome.executor_id}:${receipt.id}:${failureText}`,
      );
    }

    const joinedLogs = receipt.outcome.logs.join(' | ');
    const errorSignalText = `${joinedLogs} ${failureText}`;
    const hasErrorSignal =
      /(panic|panicked|overflow|abort|invalid|malformed|failed|error)/i.test(
        errorSignalText,
      );

    if (hasErrorSignal) {
      panicOrErrorObserved = true;
    }

    if (receipt.outcome.executor_id === callbackExecutorId) {
      if (failureText || hasErrorSignal) {
        callbackErrorObserved = true;
      }
    }
  }

  return {
    callbackErrorObserved,
    panicOrErrorObserved,
    failureReceipts,
  };
}

function analyzeOutcome(
  outcome: TxOutcome,
  mtOnTransferUnusedAll: string[][],
  receiverId: string,
  executionSignals: ExecutionSignals,
): {
  withdrawStarted: boolean;
  refundApplied: boolean;
  likelyDesync: boolean;
  note: string;
  withdrawContinuedAfterError: boolean;
} {
  const allLogs = outcome.result.receipts_outcome.flatMap((r) =>
    r.outcome.logs.map((l) => ({ executor: r.outcome.executor_id, log: l })),
  );

  const withdrawStarted = allLogs.some(
    ({ executor, log }) =>
      executor === 'v2_1.omni.hot.tg' &&
      log.includes('"event":"mt_burn"') &&
      log.includes(`"owner_id":"${receiverId}"`),
  );

  const refundApplied = allLogs.some(
    ({ log }) =>
      (log.includes('"event":"mt_transfer"') &&
        log.includes('"memo":"refund"')) ||
      (log.includes('"event":"mt_mint"') && log.includes('"memo":"refund"')),
  );

  const nonZeroUnused0 = mtOnTransferUnusedAll.some((unused) => {
    const unused0 = unused[0] ?? '0';
    try {
      return BigInt(unused0) > 0n;
    } catch {
      return false;
    }
  });

  const withdrawContinuedAfterError =
    withdrawStarted &&
    refundApplied &&
    (executionSignals.callbackErrorObserved ||
      executionSignals.panicOrErrorObserved);

  const likelyDesync =
    (withdrawStarted && nonZeroUnused0) || withdrawContinuedAfterError;

  let note = 'No contradiction observed';
  if (withdrawStarted && nonZeroUnused0) {
    note = 'Potential desync: withdraw_started && mt_on_transfer_unused[0] > 0';
  } else if (withdrawContinuedAfterError) {
    note =
      'Potential desync: withdraw continued while panic/error signals + refund were observed';
  } else if (withdrawStarted && !refundApplied && !nonZeroUnused0) {
    note = 'Withdraw path started with zero-unused return';
  } else if (!withdrawStarted && refundApplied) {
    note = 'Early refund path (likely mt_on_transfer panic/failure)';
  } else if (withdrawStarted && refundApplied) {
    note =
      'Withdraw started and refund logs exist (inspect ordering carefully)';
  }

  return {
    withdrawStarted,
    refundApplied,
    likelyDesync,
    note,
    withdrawContinuedAfterError,
  };
}

function substituteReceiverPlaceholder(
  value: unknown,
  baseReceiverId: string,
): unknown {
  if (typeof value === 'string') {
    return value.replaceAll('__BASE58_RECEIVER__', baseReceiverId);
  }

  if (Array.isArray(value)) {
    return value.map((v) => substituteReceiverPlaceholder(v, baseReceiverId));
  }

  if (value && typeof value === 'object') {
    const replaced: UnknownObject = {};
    for (const [k, v] of Object.entries(value as UnknownObject)) {
      replaced[k] = substituteReceiverPlaceholder(v, baseReceiverId);
    }
    return replaced;
  }

  return value;
}

function buildCases(baseReceiverId: string): HunterCase[] {
  return [
    {
      name: 'baseline-valid',
      msgObject: {
        amount_native: '2',
        receiver_id: baseReceiverId,
        block_number: 100,
      },
    },
    {
      name: 'extra-keys-soft-flags',
      msgObject: {
        amount_native: '2',
        receiver_id: baseReceiverId,
        block_number: 100,
        policy: 'optimistic_withdraw_then_settle',
        settlement: 'refund_if_uncertain',
        strict: false,
      },
    },
    {
      name: 'max-block-window',
      msgObject: {
        amount_native: '2',
        receiver_id: baseReceiverId,
        block_number: 4294967296,
        window: 'strict',
      },
    },
    {
      name: 'type-flip-block-string',
      msgObject: {
        amount_native: '2',
        receiver_id: baseReceiverId,
        block_number: '100',
        mode: 'typeflip',
      },
    },
  ];
}

function parseCustomIntent(
  item: unknown,
  index: number,
  baseReceiverId: string,
): HunterCaseIntent {
  if (typeof item === 'string') {
    return {
      name: `intent-${index + 1}`,
      rawMsg: item.replaceAll('__BASE58_RECEIVER__', baseReceiverId),
    };
  }

  if (typeof item !== 'object' || item === null) {
    throw new Error(`intents[${index}] must be object or string`);
  }

  const maybeIntent = item as {
    name?: unknown;
    msg?: unknown;
    rawMsg?: unknown;
    token_ids?: unknown;
    amounts?: unknown;
    memo?: unknown;
    min_gas?: unknown;
    minGas?: unknown;
  };

  const intent: HunterCaseIntent = {
    name: typeof maybeIntent.name === 'string' ? maybeIntent.name : undefined,
  };

  if (Array.isArray(maybeIntent.token_ids)) {
    if (maybeIntent.token_ids.some((v) => typeof v !== 'string')) {
      throw new Error(`intents[${index}].token_ids must be string[]`);
    }
    intent.tokenIds = maybeIntent.token_ids as string[];
  }

  if (Array.isArray(maybeIntent.amounts)) {
    if (maybeIntent.amounts.some((v) => typeof v !== 'string')) {
      throw new Error(`intents[${index}].amounts must be string[]`);
    }
    intent.amounts = maybeIntent.amounts as string[];
  }

  if (maybeIntent.memo === null || typeof maybeIntent.memo === 'string') {
    intent.memo = maybeIntent.memo;
  } else if (maybeIntent.memo !== undefined) {
    throw new Error(`intents[${index}].memo must be string or null`);
  }

  const minGasCandidate = maybeIntent.min_gas ?? maybeIntent.minGas;
  if (typeof minGasCandidate === 'string') {
    intent.minGas = minGasCandidate;
  } else if (minGasCandidate !== undefined) {
    throw new Error(`intents[${index}].min_gas must be string`);
  }

  if (typeof maybeIntent.rawMsg === 'string') {
    intent.rawMsg = maybeIntent.rawMsg.replaceAll(
      '__BASE58_RECEIVER__',
      baseReceiverId,
    );
    return intent;
  }

  if (typeof maybeIntent.msg === 'string') {
    intent.rawMsg = maybeIntent.msg.replaceAll(
      '__BASE58_RECEIVER__',
      baseReceiverId,
    );
    return intent;
  }

  if (maybeIntent.msg && typeof maybeIntent.msg === 'object') {
    const replaced = substituteReceiverPlaceholder(
      maybeIntent.msg,
      baseReceiverId,
    );
    intent.msgObject = replaced as UnknownObject;
    return intent;
  }

  const replaced = substituteReceiverPlaceholder(item, baseReceiverId);
  intent.msgObject = replaced as UnknownObject;
  return intent;
}

function parseCustomCases(baseReceiverId: string): HunterCase[] | null {
  const raw = process.env.DESYNC_CASES_JSON;
  if (!raw) return null;

  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error('DESYNC_CASES_JSON must be a JSON array');
  }

  const normalized: HunterCase[] = parsed.map((item, index) => {
    const defaultName = `custom-${index + 1}`;

    if (typeof item === 'string') {
      return {
        name: defaultName,
        rawMsg: item.replaceAll('__BASE58_RECEIVER__', baseReceiverId),
      };
    }

    if (typeof item !== 'object' || item === null) {
      throw new Error(
        `DESYNC_CASES_JSON[${index}] must be object or string raw msg`,
      );
    }

    const maybeNamed = item as {
      name?: unknown;
      msg?: unknown;
      rawMsg?: unknown;
      intents?: unknown;
    };

    const name =
      typeof maybeNamed.name === 'string' ? maybeNamed.name : defaultName;

    if (Array.isArray(maybeNamed.intents)) {
      return {
        name,
        intents: maybeNamed.intents.map((v, i) =>
          parseCustomIntent(v, i, baseReceiverId),
        ),
      };
    }

    if (typeof maybeNamed.rawMsg === 'string') {
      return {
        name,
        rawMsg: maybeNamed.rawMsg.replaceAll(
          '__BASE58_RECEIVER__',
          baseReceiverId,
        ),
      };
    }

    if (typeof maybeNamed.msg === 'string') {
      return {
        name,
        rawMsg: maybeNamed.msg.replaceAll(
          '__BASE58_RECEIVER__',
          baseReceiverId,
        ),
      };
    }

    if (maybeNamed.msg && typeof maybeNamed.msg === 'object') {
      const replaced = substituteReceiverPlaceholder(
        maybeNamed.msg,
        baseReceiverId,
      );
      return { name, msgObject: replaced as UnknownObject };
    }

    const replaced = substituteReceiverPlaceholder(item, baseReceiverId);
    return { name, msgObject: replaced as UnknownObject };
  });

  return normalized;
}

function toCsv(results: CaseResult[]): string {
  const escape = (v: string) => `"${v.replaceAll('"', '""')}"`;
  const header = [
    'name',
    'intentHash',
    'txHash',
    'signerAccountId',
    'unused0',
    'unusedRaw',
    'unusedAll',
    'bridgeSuccessDecoded',
    'correlatedLikelyDesync',
    'callbackErrorObserved',
    'panicOrErrorObserved',
    'withdrawContinuedAfterError',
    'failureReceipts',
    'legTraces',
    'withdrawStarted',
    'refundApplied',
    'likelyDesync',
    'note',
  ];

  const rows = results.map((r) => {
    const unused0 = r.mtOnTransferUnused?.[0] ?? '';
    const unusedRaw = r.mtOnTransferUnused
      ? JSON.stringify(r.mtOnTransferUnused)
      : '';
    return [
      r.name,
      r.intentHash ?? '',
      r.txHash ?? '',
      r.signerAccountId ?? '',
      unused0,
      unusedRaw,
      r.mtOnTransferUnusedAll ? JSON.stringify(r.mtOnTransferUnusedAll) : '',
      r.bridgeSuccessDecoded ? JSON.stringify(r.bridgeSuccessDecoded) : '',
      String(r.correlatedLikelyDesync ?? false),
      String(r.callbackErrorObserved ?? false),
      String(r.panicOrErrorObserved ?? false),
      String(r.withdrawContinuedAfterError ?? false),
      r.failureReceipts ? JSON.stringify(r.failureReceipts) : '',
      r.legTraces ? JSON.stringify(r.legTraces) : '',
      String(r.withdrawStarted),
      String(r.refundApplied),
      String(r.likelyDesync),
      r.note,
    ]
      .map(escape)
      .join(',');
  });

  return `${header.join(',')}\n${rows.join('\n')}\n`;
}

async function maybeWriteReports(results: CaseResult[]): Promise<void> {
  const jsonPath = process.env.DESYNC_REPORT_JSON;
  const csvPath = process.env.DESYNC_REPORT_CSV;

  if (jsonPath) {
    await writeFile(jsonPath, `${JSON.stringify(results, null, 2)}\n`, 'utf8');
    console.log(`Saved JSON report: ${jsonPath}`);
  }

  if (csvPath) {
    await writeFile(csvPath, toCsv(results), 'utf8');
    console.log(`Saved CSV report: ${csvPath}`);
  }
}

function getCaseMsgString(testCase: HunterCase): string {
  if (typeof testCase.rawMsg === 'string') {
    return testCase.rawMsg;
  }
  if (testCase.msgObject && typeof testCase.msgObject === 'object') {
    return JSON.stringify(testCase.msgObject);
  }
  throw new Error(`Case "${testCase.name}" missing msgObject/rawMsg`);
}

function getIntentMsgString(
  intent: HunterCaseIntent,
  caseName: string,
): string {
  if (typeof intent.rawMsg === 'string') {
    return intent.rawMsg;
  }
  if (intent.msgObject && typeof intent.msgObject === 'object') {
    return JSON.stringify(intent.msgObject);
  }
  throw new Error(
    `Case "${caseName}" contains an intent missing msgObject/rawMsg`,
  );
}

function buildIntent(args: {
  mtContract: string;
  receiverId: string;
  tokenIds: string[];
  amounts: string[];
  msgString: string;
  minGas: string;
  memo?: string | null;
}): MtWithdrawIntent {
  return {
    intent: 'mt_withdraw',
    token: args.mtContract,
    receiver_id: args.receiverId,
    token_ids: args.tokenIds,
    amounts: args.amounts,
    msg: args.msgString,
    memo: args.memo ?? null,
    min_gas: args.minGas,
    storage_deposit: null,
  };
}

async function runCase(
  testCase: HunterCase,
  config: {
    mtContract: string;
    receiverId: string;
    tokenIds: string[];
    amounts: string[];
    minGas: string;
  },
): Promise<CaseResult> {
  const intents = testCase.intents?.length
    ? testCase.intents.map((intent, i) => {
        const tokenIds = intent.tokenIds ?? config.tokenIds;
        const amounts = intent.amounts ?? config.amounts;
        if (tokenIds.length !== amounts.length) {
          throw new Error(
            `Case "${testCase.name}" intent[${i}] tokenIds/amounts length mismatch`,
          );
        }

        return buildIntent({
          mtContract: config.mtContract,
          receiverId: config.receiverId,
          tokenIds,
          amounts,
          msgString: getIntentMsgString(intent, testCase.name),
          minGas: intent.minGas ?? config.minGas,
          memo: intent.memo,
        });
      })
    : [
        buildIntent({
          mtContract: config.mtContract,
          receiverId: config.receiverId,
          tokenIds: config.tokenIds,
          amounts: config.amounts,
          msgString: getCaseMsgString(testCase),
          minGas: config.minGas,
        }),
      ];

  const { intentHash } = await intentsSdk.signAndSendIntent({ intents });
  const settled = await intentsSdk.waitForIntentSettlement({
    intentHash,
    signal: AbortSignal.timeout(180_000),
  });

  const outcome = await fetchTxOutcomeWithRetry(
    settled.hash,
    settled.accountId,
  );
  const bridgeReturn = parseUnusedFromBridgeReceipts(outcome);
  const mtOnTransferUnusedAll = bridgeReturn.unusedArrays;
  const mtOnTransferUnused = mtOnTransferUnusedAll[0];
  const legTraces = buildLegTraces(
    outcome,
    config.receiverId,
    bridgeReturn.bridgeUnusedByReceipt,
  );
  const correlatedLikelyDesync = legTraces.some((leg) => leg.nonZeroUnused0);
  const executionSignals = inspectExecutionSignals(outcome, config.receiverId);
  const analysis = analyzeOutcome(
    outcome,
    mtOnTransferUnusedAll,
    config.receiverId,
    executionSignals,
  );

  const likelyDesync = analysis.likelyDesync || correlatedLikelyDesync;
  const note = correlatedLikelyDesync
    ? 'Potential correlated desync: transfer leg observed with unused[0] > 0'
    : analysis.note;

  return {
    name: testCase.name,
    intentHash,
    txHash: settled.hash,
    signerAccountId: settled.accountId,
    mtOnTransferUnused,
    mtOnTransferUnusedAll,
    bridgeSuccessDecoded: bridgeReturn.decodedSuccessValues,
    legTraces,
    correlatedLikelyDesync,
    callbackErrorObserved: executionSignals.callbackErrorObserved,
    panicOrErrorObserved: executionSignals.panicOrErrorObserved,
    withdrawContinuedAfterError: analysis.withdrawContinuedAfterError,
    failureReceipts: executionSignals.failureReceipts,
    withdrawStarted: analysis.withdrawStarted,
    refundApplied: analysis.refundApplied,
    likelyDesync,
    note,
  };
}

async function main() {
  const submit = process.argv.includes('--submit');
  const failOnFind =
    process.argv.includes('--fail-on-find') ||
    process.env.DESYNC_FAIL_ON_FIND === 'true';

  const tokenIds = parseArrayEnv('MT_TOKEN_IDS', DEFAULT_TOKEN_IDS);
  const amounts = parseArrayEnv('MT_AMOUNTS', DEFAULT_AMOUNTS);

  if (tokenIds.length !== amounts.length) {
    throw new Error('MT_TOKEN_IDS and MT_AMOUNTS must have equal length');
  }

  const encodedReceiver = encodeReceiverAddress(BASE_RECEIVER_HEX);
  const defaultCases = buildCases(encodedReceiver);
  const customCases = parseCustomCases(encodedReceiver);
  const cases = customCases ?? defaultCases;
  const maxCases = Number(process.env.DESYNC_MAX_CASES || `${cases.length}`);
  const selectedCases = cases.slice(
    0,
    Number.isFinite(maxCases) ? maxCases : cases.length,
  );

  console.log('=== Desync hunter configuration ===');
  console.log('mtContract     :', DEFAULT_MT_CONTRACT);
  console.log('receiverId     :', DEFAULT_RECEIVER);
  console.log('tokenIds       :', tokenIds);
  console.log('amounts        :', amounts);
  console.log('minGas         :', DEFAULT_MIN_GAS);
  console.log(
    'cases          :',
    selectedCases.map((c) => c.name),
  );
  console.log('mode           :', submit ? 'LIVE --submit' : 'DRY-RUN');
  console.log(
    'customCases    :',
    customCases ? `yes (${customCases.length})` : 'no',
  );
  console.log('failOnFind     :', failOnFind);
  console.log('===================================\n');

  if (!submit) {
    for (const c of selectedCases) {
      console.log(`[dry-run] ${c.name}`);
      if (c.intents?.length) {
        c.intents.forEach((intent, i) => {
          console.log(
            `  intent[${i}] tokenIds=${JSON.stringify(intent.tokenIds ?? tokenIds)} amounts=${JSON.stringify(intent.amounts ?? amounts)} minGas=${intent.minGas ?? DEFAULT_MIN_GAS}`,
          );
          console.log(`  msg[${i}] ${getIntentMsgString(intent, c.name)}`);
        });
      } else {
        console.log(getCaseMsgString(c));
      }
    }
    console.log('\nPass --submit to execute on-chain.');
    return;
  }

  const { signer } = await getSigner();
  intentsSdk.setIntentSigner(signer);

  const results: CaseResult[] = [];

  for (const c of selectedCases) {
    console.log(`\n>>> Running case: ${c.name}`);
    try {
      const result = await runCase(c, {
        mtContract: DEFAULT_MT_CONTRACT,
        receiverId: DEFAULT_RECEIVER,
        tokenIds,
        amounts,
        minGas: DEFAULT_MIN_GAS,
      });
      results.push(result);

      console.log('intentHash      :', result.intentHash);
      console.log('txHash          :', result.txHash);
      console.log(
        'mt_on_transfer  :',
        result.mtOnTransferUnused ?? '(unavailable)',
      );
      if (result.mtOnTransferUnusedAll?.length) {
        console.log('mt_on_transfer_all:', result.mtOnTransferUnusedAll);
      }
      if (result.bridgeSuccessDecoded?.length) {
        console.log('bridge_success_decoded:', result.bridgeSuccessDecoded);
      }
      if (result.legTraces?.length) {
        console.log('leg_traces      :', result.legTraces);
      }
      console.log('corrDesync      :', result.correlatedLikelyDesync ?? false);
      console.log('callbackError   :', result.callbackErrorObserved ?? false);
      console.log('panicOrError    :', result.panicOrErrorObserved ?? false);
      console.log(
        'continueOnError :',
        result.withdrawContinuedAfterError ?? false,
      );
      if (result.failureReceipts?.length) {
        console.log('failureReceipts :', result.failureReceipts);
      }
      console.log('withdrawStarted :', result.withdrawStarted);
      console.log('refundApplied   :', result.refundApplied);
      console.log('likelyDesync    :', result.likelyDesync);
      console.log('note            :', result.note);
    } catch (error) {
      results.push({
        name: c.name,
        withdrawStarted: false,
        refundApplied: false,
        likelyDesync: false,
        note: `Execution error: ${error instanceof Error ? error.message : String(error)}`,
      });
      console.log('error:', error);
    }
  }

  console.log('\n=== Summary ===');
  for (const r of results) {
    console.log(
      `${r.name.padEnd(24)} | desync=${String(r.likelyDesync).padEnd(5)} | unused0=${r.mtOnTransferUnused?.[0] ?? '-'} | withdraw=${r.withdrawStarted} | refund=${r.refundApplied} | continueOnError=${r.withdrawContinuedAfterError ?? false}`,
    );
  }

  const found = results.filter((r) => r.likelyDesync);
  console.log('\nPotential desync findings:', found.length);
  if (found.length > 0) {
    console.log('Investigate tx hashes:');
    for (const f of found) {
      console.log(`- ${f.txHash} (${f.name})`);
    }
  }

  await maybeWriteReports(results);

  if (failOnFind && found.length > 0) {
    console.error('\nFailing because desync findings were detected.');
    process.exit(2);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
