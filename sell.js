import fs from "node:fs";
import { ethers } from "ethers";

if (fs.existsSync(".env")) process.loadEnvFile(".env");

const MARKET = "0xfad7d1300e43a7b8f0b5a2fe5ef9a306f89c6efc";
const RELIC = "0xe8c6b38b5e63377a96b268319b66638f772254bb";
const BIDS_SLOT = 8n;
const KIND_RELIC = 0;
const CACHE_FILE = ".bids-cache.json";
const MASK160 = (1n << 160n) - 1n;

const env = (key, def) => {
  const v = process.env[key];
  return v === undefined || v.trim() === "" ? def : v.trim();
};

const cfg = {
  rpc: env("RPC_URL", "https://bsc-dataseed.bnbchain.org"),
  keys: env("PRIVATE_KEYS", env("PRIVATE_KEY", ""))
    .split(/[\s,;]+/)
    .filter(Boolean),
  maxGap: ethers.parseUnits(env("MAX_GAP_USD", "2"), 18),
  minPrice: ethers.parseUnits(env("MIN_PRICE_USD", "0"), 18),
  maxPerTx: Number(env("MAX_PER_TX", "30")),
  gasPrice: env("GAS_PRICE_GWEI", "") ? ethers.parseUnits(env("GAS_PRICE_GWEI", ""), "gwei") : null,
  dryRun: env("DRY_RUN", "0") === "1",
  loop: env("LOOP", "0") === "1",
  interval: Number(env("INTERVAL_MS", "5000")),
  revokeAfter: env("REVOKE_AFTER", "0") === "1",
  batchSize: Number(env("BATCH_SIZE", "50")),
  concurrency: Number(env("CONCURRENCY", "4")),
  rounds: Number(env("ROUNDS", "3")),
};

const bookOnly = process.argv.includes("--book");

const provider = new ethers.JsonRpcProvider(cfg.rpc, 56, { staticNetwork: true });

const market = new ethers.Contract(
  MARKET,
  [
    "function fill(uint256 bidId, uint256[] tokenIds)",
    "function nextBidId() view returns (uint256)",
    "function feeBps() view returns (uint16)",
  ],
  provider,
);

const relic = new ethers.Contract(
  RELIC,
  [
    "function balanceOf(address) view returns (uint256)",
    "function tokenOfOwnerByIndex(address,uint256) view returns (uint256)",
    "function isApprovedForAll(address,address) view returns (bool)",
    "function setApprovalForAll(address,bool)",
  ],
  provider,
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const usd = (v) => Number(ethers.formatUnits(v, 18)).toFixed(3);
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

let rpcId = 0;

async function rpcBatch(calls) {
  const body = calls.map(([method, params]) => ({ jsonrpc: "2.0", id: ++rpcId, method, params }));
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(cfg.rpc, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      if (!Array.isArray(json)) throw new Error(`batch rejected: ${JSON.stringify(json).slice(0, 200)}`);
      const byId = new Map(json.map((r) => [r.id, r]));
      return body.map((b) => {
        const r = byId.get(b.id);
        if (!r || r.error) throw new Error(`rpc error: ${JSON.stringify(r?.error ?? "missing")}`);
        return r.result;
      });
    } catch (e) {
      if (attempt >= 6) throw e;
      await sleep(800 * (attempt + 1));
    }
  }
}

async function pool(items, size, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, worker));
  return out;
}

const chunk = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));

const bidSlot = (id) => BigInt(ethers.solidityPackedKeccak256(["uint256", "uint256"], [id, BIDS_SLOT]));

async function readSlots(slots) {
  const parts = await pool(chunk(slots, cfg.batchSize), cfg.concurrency, (part) =>
    rpcBatch(part.map((s) => ["eth_getStorageAt", [MARKET, ethers.toQuantity(s), "latest"]])),
  );
  return parts.flat().map((v) => BigInt(v));
}

async function readQty(ids) {
  const vals = await readSlots(ids.map((id) => bidSlot(id) + 2n));
  return ids.map((id, i) => ({ id, qty: Number(vals[i] & 0xffffffffn) }));
}

async function readBids(ids) {
  const slots = ids.flatMap((id) => {
    const b = bidSlot(id);
    return [b, b + 1n, b + 2n];
  });
  const vals = await readSlots(slots);
  return ids.map((id, i) => {
    const [w0, w1, w2] = vals.slice(i * 3, i * 3 + 3);
    return {
      id,
      bidder: ethers.getAddress(ethers.toBeHex(w0 & MASK160, 20)),
      kind: Number((w0 >> 160n) & 0xffn),
      price: w1,
      qty: Number(w2 & 0xffffffffn),
      feeBps: Number((w2 >> 32n) & 0xffffn),
    };
  });
}

function loadCache() {
  try {
    return JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
  } catch {
    return { scanned: 0, open: [] };
  }
}

async function scanBook() {
  const cache = loadCache();
  const next = Number(await market.nextBidId());
  const fresh = [];
  for (let id = cache.scanned; id < next; id++) fresh.push(id);
  if (fresh.length > 500) log(`scanning ${fresh.length} bids, first run takes a while...`);
  const freshOpen = (await readQty(fresh)).filter((b) => b.qty > 0).map((b) => b.id);
  const ids = [...new Set([...cache.open, ...freshOpen])];
  const open = (await readBids(ids)).filter((b) => b.qty > 0 && b.qty <= 100000);
  fs.writeFileSync(CACHE_FILE, JSON.stringify({ scanned: next, open: open.map((b) => b.id) }));
  return open;
}

function printBook(open, levels = 15) {
  const agg = new Map();
  for (const b of open.filter((b) => b.kind === KIND_RELIC)) {
    const k = b.price.toString();
    agg.set(k, (agg.get(k) ?? 0) + b.qty);
  }
  const rows = [...agg.entries()].map(([p, q]) => [BigInt(p), q]).sort((a, b) => (b[0] > a[0] ? 1 : -1));
  const total = rows.reduce((s, [, q]) => s + q, 0);
  log(`relic book: ${rows.length} levels, ${total} NFT wanted`);
  for (const [p, q] of rows.slice(0, levels)) console.log(`   ${usd(p).padStart(9)} USDT  x ${q}`);
}

async function loadWallet(w) {
  const [bal, approved, bnb] = await Promise.all([
    relic.balanceOf(w.address),
    relic.isApprovedForAll(w.address, MARKET),
    provider.getBalance(w.address),
  ]);
  const idx = Array.from({ length: Number(bal) }, (_, i) => i);
  const tokens = await pool(idx, 8, (i) => relic.tokenOfOwnerByIndex(w.address, i));
  return { wallet: w, address: w.address, tokens, approved, bnb };
}

function plan(open, states) {
  const own = new Set(states.map((s) => s.address.toLowerCase()));
  const eligible = open
    .filter((b) => b.kind === KIND_RELIC && b.qty > 0 && b.price >= cfg.minPrice && !own.has(b.bidder.toLowerCase()))
    .sort((a, b) => (b.price !== a.price ? (b.price > a.price ? 1 : -1) : a.id - b.id));
  if (!eligible.length) return { orders: [], top: null, floor: null };
  const top = eligible[0].price;
  const floor = top - cfg.maxGap;
  const levels = eligible.filter((b) => b.price >= floor);
  const left = new Map(levels.map((b) => [b.id, b.qty]));
  const orders = [];
  for (const s of states) {
    const tokens = [...s.tokens];
    for (const b of levels) {
      while (tokens.length && left.get(b.id) > 0) {
        const n = Math.min(left.get(b.id), tokens.length, cfg.maxPerTx);
        orders.push({ state: s, bid: b, tokenIds: tokens.splice(0, n) });
        left.set(b.id, left.get(b.id) - n);
      }
      if (!tokens.length) break;
    }
  }
  return { orders, top, floor };
}

const overrides = () => (cfg.gasPrice ? { gasPrice: cfg.gasPrice } : {});

async function ensureApproval(s) {
  if (s.approved) return true;
  log(`${s.address} setApprovalForAll(market)`);
  if (cfg.dryRun) return true;
  const tx = await relic.connect(s.wallet).setApprovalForAll(MARKET, true, overrides());
  const rc = await tx.wait();
  s.approved = rc.status === 1;
  s.approvedByUs = s.approved;
  log(`${s.address} approval ${s.approved ? "ok" : "FAILED"} ${tx.hash}`);
  return s.approved;
}

async function executeWallet(s, orders) {
  if (!(await ensureApproval(s))) return { ok: 0, failed: orders.length };
  let nonce = await provider.getTransactionCount(s.address, "pending");
  const pending = [];
  let failed = 0;
  const m = market.connect(s.wallet);
  for (const o of orders) {
    const gross = o.bid.price * BigInt(o.tokenIds.length);
    const net = gross - (gross * BigInt(o.bid.feeBps)) / 10000n;
    const tag = `${s.address.slice(0, 8)} bid #${o.bid.id} @ ${usd(o.bid.price)} x${o.tokenIds.length} -> ~${usd(net)} USDT`;
    if (cfg.dryRun) {
      log(`[dry] ${tag} ids=${o.tokenIds.join(",")}`);
      continue;
    }
    try {
      const gas = await m.fill.estimateGas(o.bid.id, o.tokenIds);
      const tx = await m.fill(o.bid.id, o.tokenIds, { ...overrides(), nonce: nonce++, gasLimit: (gas * 13n) / 10n });
      log(`sent ${tag} ${tx.hash}`);
      pending.push(
        tx.wait().then(
          (rc) => {
            log(`${rc.status === 1 ? "OK  " : "FAIL"} ${tag}`);
            return rc.status === 1;
          },
          (e) => {
            log(`FAIL ${tag}: ${e.shortMessage ?? e.message}`);
            return false;
          },
        ),
      );
    } catch (e) {
      failed++;
      log(`skip ${tag}: ${e.shortMessage ?? e.message}`);
    }
  }
  const results = await Promise.all(pending);
  const ok = results.filter(Boolean).length;
  return { ok, failed: failed + results.length - ok };
}

async function revoke(states) {
  for (const s of states.filter((s) => s.approvedByUs)) {
    const tx = await relic.connect(s.wallet).setApprovalForAll(MARKET, false, overrides());
    await tx.wait();
    log(`${s.address} approval revoked ${tx.hash}`);
  }
}

async function round(wallets, approvedByUs) {
  const [open, states] = await Promise.all([scanBook(), Promise.all(wallets.map(loadWallet))]);
  for (const s of states) if (approvedByUs.has(s.address)) s.approvedByUs = true;
  const holding = states.filter((s) => s.tokens.length);
  const { orders, top, floor } = plan(open, holding);
  if (!top) {
    log("no relic bids in the book");
    return { done: true, states };
  }
  const totalTokens = holding.reduce((n, s) => n + s.tokens.length, 0);
  log(`top ${usd(top)} USDT, selling down to ${usd(floor)} | wallets with relics: ${holding.length}, relics: ${totalTokens}`);
  for (const s of holding)
    if (s.bnb === 0n) log(`warning: ${s.address} has 0 BNB for gas`);
  if (!orders.length) return { done: totalTokens === 0, states };
  const byWallet = new Map();
  for (const o of orders) byWallet.set(o.state, [...(byWallet.get(o.state) ?? []), o]);
  const res = await Promise.all([...byWallet].map(([s, os]) => executeWallet(s, os)));
  for (const s of states) if (s.approvedByUs) approvedByUs.add(s.address);
  const sold = orders.reduce((n, o) => n + o.tokenIds.length, 0);
  const failed = res.reduce((n, r) => n + r.failed, 0);
  return { done: !cfg.dryRun && failed === 0 && sold === totalTokens, states, failed };
}

async function main() {
  log(`rpc ${cfg.rpc}`);
  if (bookOnly) {
    printBook(await scanBook(), 30);
    return;
  }
  if (!cfg.keys.length) throw new Error("set PRIVATE_KEYS (comma separated) in env or .env");
  const wallets = cfg.keys.map((k) => new ethers.Wallet(k.startsWith("0x") ? k : `0x${k}`, provider));
  log(`wallets: ${wallets.map((w) => w.address).join(", ")}`);
  log(`max gap ${usd(cfg.maxGap)} USDT, min price ${usd(cfg.minPrice)} USDT${cfg.dryRun ? ", DRY RUN" : ""}`);
  const approvedByUs = new Set();
  let states = [];
  if (cfg.loop) {
    for (;;) {
      try {
        ({ states } = await round(wallets, approvedByUs));
      } catch (e) {
        log(`round error: ${e.shortMessage ?? e.message}`);
      }
      await sleep(cfg.interval);
    }
  }
  for (let i = 0; i < cfg.rounds; i++) {
    const r = await round(wallets, approvedByUs);
    states = r.states;
    if (r.done || cfg.dryRun) break;
    await sleep(1500);
  }
  if (cfg.revokeAfter && !cfg.dryRun) await revoke(states);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
