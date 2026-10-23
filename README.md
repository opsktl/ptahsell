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
cp .env.example .env
```

Fill in `.env`:

| Variable | Default | Description |
| --- | --- | --- |
| `PRIVATE_KEYS` | | Comma separated private keys of wallets holding relics |
| `RPC_URL` | `https://bsc-dataseed.bnbchain.org` | BSC RPC endpoint (must support JSON-RPC batch requests) |
| `MAX_GAP_USD` | `2` | Sell only into bids priced at most this far below the top bid |
| `MIN_PRICE_USD` | `0` | Never sell below this price |
| `MAX_PER_TX` | `30` | Max NFTs per `fill` transaction |
| `GAS_PRICE_GWEI` | network | Fixed gas price |
| `DRY_RUN` | `0` | `1` prints the plan without sending transactions |
| `LOOP` | `0` | `1` keeps running and sells whenever relics or new bids appear |
| `INTERVAL_MS` | `5000` | Delay between rounds in loop mode |
| `REVOKE_AFTER` | `0` | `1` revokes the market approval after selling |
| `ROUNDS` | `3` | Retry rounds in single run mode |
| `BATCH_SIZE` | `50` | Storage reads per RPC batch |
| `CONCURRENCY` | `4` | Parallel RPC batches |

## Usage

```
npm run book    # print the current relic bid book
npm run sell    # sell
```

Run with `DRY_RUN=1` first to see which bids would be hit.

## How it works

1. Reads open bids directly from the market contract storage and caches them in `.bids-cache.json`. The first scan reads every bid and can take a few minutes on a public RPC. Later runs only read new and still open bids.
2. Loads relic token IDs for every wallet.
3. Sends `setApprovalForAll(market, true)` on the relic contract if the wallet has not approved the market yet.
4. Splits the tokens across the top bids, skipping bids placed by your own wallets, and calls `fill(bidId, tokenIds)`. Every fill is gas-estimated first, so bids already taken by someone else are skipped, then the book is re-read and the next round runs.

Each wallet needs some BNB for gas (about 130k gas per single-NFT fill, plus a one-time approval).

A fast private RPC is strongly recommended: top bids get taken quickly.
