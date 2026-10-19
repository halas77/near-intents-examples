import { nearJsonRpcProvider } from './utils/config';

async function main() {
  const accountId = 'roughrobe4214.near';
  const tokenId = 'nep141:wrap.near';

  const result = await nearJsonRpcProvider.callFunction<string[]>({
    contractId: 'intents.near',
    method: 'mt_batch_balance_of',
    args: {
      account_id: accountId,
      token_ids: [tokenId],
    },
  });

  console.log('Account:', accountId);
  console.log('Token:', tokenId);
  console.log('Raw Intents balance:', result?.[0]);
}

main().catch(console.error);
