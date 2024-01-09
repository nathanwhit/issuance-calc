import { ApiPromise, WsProvider } from "@polkadot/api";

import { z } from "zod";
import { ApiDecoration } from "@polkadot/api/types";

const TokenInfo = z.object({
  data: z.object({
    detail: z.object({
      CTC: z.object({
        total_issuance: z.string(),
        free_balance: z.string(),
        available_balance: z.string(),
        locked_balance: z.string(),
        reserved_balance: z.string(),
      }),
    }),
  }),
});

type TokenInfo = z.infer<typeof TokenInfo>;

async function getSubscanToken(network = "creditcoin") {
  const url = `https://${network}.api.subscan.io/api/scan/token`;
  const resp = await (await fetch(url)).json();
  const parsed = TokenInfo.parse(resp);
  return parsed.data.detail.CTC;
}

const BlockListResponse = z.object({
  code: z.number(),
  message: z.string(),
  generated_at: z.number(),
  data: z.object({
    blocks: z.array(
      z.object({
        block_num: z.number(),
        hash: z.string(),
        finalized: z.boolean(),
      })
    ),
    count: z.number(),
  }),
});

async function getSubscanLatestBlock(network = "creditcoin") {
  const url = `https://${network}.api.subscan.io/api/scan/blocks`;
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      page: 0,
      row: 1,
    }),
  });
  const body = await resp.json();
  const parsed = BlockListResponse.parse(body);
  return parsed.data.blocks[0];
}

type StartKey = any;

async function fetchAccounts(
  api: ApiDecoration<"promise">,
  startKey?: StartKey
) {
  const accounts = await api.query.system.account.entriesPaged({
    pageSize: 1000,
    args: [],
    startKey,
  });
  return accounts;
}

function max(a: bigint, b: bigint) {
  return a > b ? a : b;
}

async function unbonding(api: ApiDecoration<"promise">) {
  const ledgers = await api.query.staking.ledger.entries();
  return ledgers.reduce((acc, [_accountId, ledger]) => {
    return (
      acc +
      ledger.unwrap().unlocking.reduce((unl, unlockChunk) => {
        return unl + unlockChunk.value.toBigInt();
      }, BigInt(0))
    );
  }, BigInt(0));
}

async function calculateTokenInfo(api: ApiDecoration<"promise">) {
  const start = performance.now();
  let accounts = await fetchAccounts(api);
  let runningTotal = BigInt(0);
  let runningLockedUp = BigInt(0);
  let runningReserved = BigInt(0);
  let count = 0;

  while (accounts.length > 0) {
    if (count % 10000 === 0) {
      const end = performance.now();
      const secs = (end - start) / 1000;
      const perSec = count / secs;
      console.log(`Processed ${count} accounts (${perSec} acct/s)`);
    }
    const next = accounts[accounts.length - 1][0];
    const newAccounts = accounts;
    for (const [
      _accountId,
      {
        data: {
          free: freeRaw,
          feeFrozen: feeFrozenRaw,
          miscFrozen: miscFrozenRaw,
          reserved: reservedRaw,
        },
      },
    ] of newAccounts) {
      const free = freeRaw.toBigInt();
      const feeFrozen = feeFrozenRaw.toBigInt();
      const miscFrozen = miscFrozenRaw.toBigInt();
      const reserved = reservedRaw.toBigInt();

      runningTotal += free + reserved;
      runningLockedUp += max(miscFrozen, feeFrozen);
      runningReserved += reserved;
    }
    accounts = await fetchAccounts(api, next);
    count += newAccounts.length;
  }

  const unbondingTotal = await unbonding(api);

  console.log(`Total accounts: ${count}`);

  return {
    lockedUp: runningLockedUp,
    total: runningTotal,
    reserved: runningReserved,
    unbonding: unbondingTotal,
  };
}

async function main(apii: ApiPromise) {
  const { hash: blockHash } = await getSubscanLatestBlock();

  const api = await apii.at(blockHash);

  const tokenInfo = await getSubscanToken();

  const { lockedUp, total, reserved, unbonding } = await calculateTokenInfo(
    api
  );

  console.log(`Subscan total issuance: ${tokenInfo.total_issuance}`);
  console.log(`Subscan free balance: ${tokenInfo.free_balance}`);
  console.log(`Subscan available balance: ${tokenInfo.available_balance}`);
  console.log(`Subscan locked balance: ${tokenInfo.locked_balance}`);
  console.log(`Subscan reserved balance: ${tokenInfo.reserved_balance}`);
  console.log(`-------------------------------`);
  console.log(`Total issuance: ${total}`);
  console.log(`Locked up: ${lockedUp}`);
  const circulating = total - lockedUp;
  console.log(`Circulating: ${circulating}`);
  console.log(`Unbonding: ${unbonding}`);
  console.log(`Reserved: ${reserved}`);
}

async function withApi<T>(
  endpoint: string,
  f: (api: ApiPromise) => Promise<T>
): Promise<T> {
  const api = await ApiPromise.create({
    provider: new WsProvider(endpoint),
    noInitWarn: true,
  });

  try {
    const result = await f(api);
    return result;
  } finally {
    api.disconnect();
  }
}

withApi("wss://rpc.mainnet.creditcoin.network/ws", main).catch((e) =>
  console.error(e)
);
