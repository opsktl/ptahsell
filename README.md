# Ptah Relic Seller

Sells Ptah Relic NFTs (BSC) straight into the top buy bids of the [ptah.trade](https://ptah.trade/market) on-chain order book.

The bot finds the highest relic bid and sells only into bids priced within `MAX_GAP_USD` of it. Lower bids are never touched.

## Contracts (BSC)

| Contract | Address |
| --- | --- |
| Market (bid book) | `0xfad7d1300e43a7b8f0b5a2fe5ef9a306f89c6efc` |
| Relic NFT | `0xe8c6b38b5e63377a96b268319b66638f772254bb` |
| Minter | `0xB0D5f3108aF164f5F7046F53ab59FD2779812d10` |

Bids are escrowed in USDT. The market takes a 1% fee from the seller.

## Setup

Requires Node.js 22+.

```
npm install
cp env.example .env
```

Fill in `.env`:

| Variable | Default | Description |
| --- | --- | --- |
| `PRIVATE_KEYS` | | Comma separated private keys of wallets holding relics |
| `RPC_URL` | `https://bsc-dataseed.bnbchain.org` | BSC HTTP RPC for reads and transactions (must support JSON-RPC batch requests) |
| `WS_URL` | `wss://bsc-rpc.publicnode.com` | BSC WebSocket RPC for live events (`watch` mode) |
| `MAX_GAP_USD` | `2` | Sell only into bids priced at most this far below the top bid |
| `MIN_PRICE_USD` | `0` | Never sell below this price |
| `MAX_PER_TX` | `30` | Max NFTs per `fill` transaction |
| `GAS_PRICE_GWEI` | network | Fixed gas price |
| `DRY_RUN` | `0` | `1` prints the plan without sending transactions |
| `REVOKE_AFTER` | `0` | `1` revokes the market approval after a one-shot `sell` |
| `ROUNDS` | `3` | Retry rounds for one-shot `sell` |
| `RESYNC_MS` | `60000` | How often `watch` re-reads the full book from storage |
| `BATCH_SIZE` | `50` | Storage reads per RPC batch |
| `CONCURRENCY` | `4` | Parallel RPC batches |

## Usage

```
npm run approve   # approve the market for all wallets in advance
npm run book      # print the current relic bid book
npm run sell      # sell everything once into the top bids
npm run watch     # stay online and sell the moment a good bid or a new relic appears
```

Run with `DRY_RUN=1` first to see which bids would be hit.

## How it works

1. On start every wallet is checked and `setApprovalForAll(market, true)` is sent where missing, so at sale time only `fill` transactions go out. `npm run approve` does just this step.
2. Open bids are read directly from the market contract storage and cached in `.bids-cache.json`. The first scan reads every bid and can take a few minutes on a public RPC. Later runs only read new and still open bids.
3. Tokens are split across the top bids, skipping bids placed by your own wallets, and sold with `fill(bidId, tokenIds)`. Transactions are sent with a precomputed gas limit and locally tracked nonces, without an estimate round trip.
4. In `watch` mode the bot subscribes over WebSocket to market events (new bids, fills, cancels) and to relic transfers into or out of your wallets. A new top bid or newly received relics trigger a sale immediately. The full book is re-read every `RESYNC_MS` and after any failed fill. A dropped WebSocket is detected and reconnected automatically.

Each wallet needs some BNB for gas (about 130k gas per single-NFT fill, plus a one-time approval).

A fast private RPC is strongly recommended: top bids get taken quickly.
