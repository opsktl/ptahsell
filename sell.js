import fs from "node:fs";
import { ethers } from "ethers";

if (fs.existsSync(".env")) process.loadEnvFile(".env");

const MARKET = "0xfad7d1300e43a7b8f0b5a2fe5ef9a306f89c6efc";
const RELIC = "0xe8c6b38b5e63377a96b268319b66638f772254bb";
const BIDS_SLOT = 8n;
const KIND_RELIC = 0;
const MAX_SANE_QTY = 100000;
const CACHE_FILE = ".bids-cache.json";
const MASK160 = (1n << 160n) - 1n;
const TOPIC_BID = "0xb45150e472fb86c9ca22b4188a3e2081b13d4d0b69ade38df56733345bfa9735";
const TOPIC_FILL = "0x7f748690209a8a1dfeb424cb1f545fd5fadbc24e23e4a158ad56d5999442ec5a";
const TOPIC_CANCEL = "0x5f3677452343f3e91b0f32c2cc8fdb1d2004d9add0b2789192024734138baab4";
const TOPIC_TRANSFER = ethers.id("Transfer(address,address,uint256)");

const env = (key, def) => {
  const v = process.env[key];
  return v === undefined || v.trim() === "" ? def : v.trim();
};

const cfg = {
  rpc: env("RPC_URL", "https://bsc-dataseed.bnbchain.org"),
  ws: env("WS_URL", "wss://bsc-rpc.publicnode.com"),
  keys: env("PRIVATE_KEYS", env("PRIVATE_KEY", ""))
    .split(/[\s,;]+/)
    .filter(Boolean),
  maxGap: ethers.parseUnits(env("MAX_GAP_USD", "2"), 18),
  minPrice: ethers.parseUnits(env("MIN_PRICE_USD", "0"), 18),
  maxPerTx: Number(env("MAX_PER_TX", "30")),
  gasPrice: env("GAS_PRICE_GWEI", "") ? ethers.parseUnits(env("GAS_PRICE_GWEI", ""), "gwei") : null,
  dryRun: env("DRY_RUN", "0") === "1",
  revokeAfter: env("REVOKE_AFTER", "0") === "1",
  rounds: Number(env("ROUNDS", "3")),
  resyncMs: Number(env("RESYNC_MS", "60000")),
  batchSize: Number(env("BATCH_SIZE", "50")),
  concurrency: Number(env("CONCURRENCY", "4")),
};

const command = process.argv[2] ?? "sell";

const provider = new ethers.JsonRpcProvider(cfg.rpc, 56, { staticNetwork: true });

const marketIface = new ethers.Interface(["function fill(uint256 bidId, uint256[] tokenIds)"]);
const market = new ethers.Contract(MARKET, ["function nextBidId() view returns (uint256)"], provider);
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

const coder = ethers.AbiCoder.defaultAbiCoder();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const usd = (v) => Number(ethers.formatUnits(v, 18)).toFixed(3);
const log = (...a) => console.log(new Date().toISOString().slice(11, 23), ...a);
const errMsg = (e) => e?.shortMessage ?? e?.message ?? String(e);
const short = (a) => a.slice(0, 8);

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

const book = new Map();

async function scanBook() {
  const cache = loadCache();
  const next = Number(await market.nextBidId());
  const fresh = [];
  for (let id = cache.scanned; id < next; id++) fresh.push(id);
  if (fresh.length > 500) log(`scanning ${fresh.length} bids, first run takes a while...`);
  const freshOpen = (await readQty(fresh)).filter((b) => b.qty > 0).map((b) => b.id);
  const ids = [...new Set([...cache.open, ...freshOpen])];
  const open = (await readBids(ids)).filter((b) => b.qty > 0 && b.qty <= MAX_SANE_QTY);
  fs.writeFileSync(CACHE_FILE, JSON.stringify({ scanned: next, open: open.map((b) => b.id) }));
  book.clear();
  for (const b of open) book.set(b.id, b);
  return open;
}

function applyMarketLog(l) {
  const t = l.topics[0];
  const id = Number(BigInt(l.topics[1]));
  if (t === TOPIC_BID) {
    const [price, qty, feeBps] = coder.decode(["uint256", "uint256", "uint256"], l.data);
    const bid = {
      id,
      bidder: ethers.getAddress(ethers.dataSlice(l.topics[2], 12)),
      kind: Number(BigInt(l.topics[3])),
      price,
      qty: Number(qty),
      feeBps: Number(feeBps),
    };
    if (bid.qty > 0 && bid.qty <= MAX_SANE_QTY) book.set(id, bid);
    return bid.kind === KIND_RELIC ? bid : null;
  }
  if (t === TOPIC_FILL) {
    const b = book.get(id);
    if (b && --b.qty <= 0) book.delete(id);
    return null;
  }
  if (t === TOPIC_CANCEL) book.delete(id);
  return null;
}

function printBook(levels = 15) {
  const agg = new Map();
  for (const b of book.values()) {
    if (b.kind !== KIND_RELIC) continue;
    const k = b.price.toString();
    agg.set(k, (agg.get(k) ?? 0) + b.qty);
  }
  const rows = [...agg.entries()].map(([p, q]) => [BigInt(p), q]).sort((a, b) => (b[0] > a[0] ? 1 : -1));
  const total = rows.reduce((s, [, q]) => s + q, 0);
  log(`relic book: ${rows.length} levels, ${total} NFT wanted`);
  for (const [p, q] of rows.slice(0, levels)) console.log(`   ${usd(p).padStart(9)} USDT  x ${q}`);
}

function makeState(wallet) {
  return { wallet, address: wallet.address, tokens: [], pending: new Set(), approved: false, approvedByUs: false, nonce: null, bnb: 0n };
}

async function loadWallet(s) {
  const [bal, approved, bnb] = await Promise.all([
    relic.balanceOf(s.address),
    relic.isApprovedForAll(s.address, MARKET),
    provider.getBalance(s.address),
  ]);
  const idx = Array.from({ length: Number(bal) }, (_, i) => i);
  const tokens = await pool(idx, 8, (i) => relic.tokenOfOwnerByIndex(s.address, i));
  s.tokens = tokens.filter((t) => !s.pending.has(t.toString()));
  s.approved = approved;
  s.bnb = bnb;
  return s;
}

let gasCache = { value: null, at: 0 };

async function gasPrice() {
  if (cfg.gasPrice) return cfg.gasPrice;
  if (!gasCache.value || Date.now() - gasCache.at > 30000) {
    gasCache = { value: (await provider.getFeeData()).gasPrice, at: Date.now() };
  }
  return gasCache.value;
}

async function approveAll(states) {
  await Promise.all(
    states.map(async (s) => {
      if (s.approved) return;
      log(`${s.address} setApprovalForAll(market, true)`);
      if (cfg.dryRun) return;
      try {
        const tx = await relic.connect(s.wallet).setApprovalForAll(MARKET, true, { gasPrice: await gasPrice() });
        const rc = await tx.wait();
        s.approved = rc.status === 1;
        s.approvedByUs = s.approved;
        log(`${s.address} approval ${s.approved ? "ok" : "FAILED"} ${tx.hash}`);
      } catch (e) {
        log(`${s.address} approval FAILED: ${errMsg(e)}`);
      }
    }),
  );
}

async function revokeAll(states) {
  for (const s of states.filter((s) => s.approvedByUs)) {
    const tx = await relic.connect(s.wallet).setApprovalForAll(MARKET, false, { gasPrice: await gasPrice() });
    await tx.wait();
    log(`${s.address} approval revoked ${tx.hash}`);
  }
}

function plan(states) {
  const own = new Set(states.map((s) => s.address.toLowerCase()));
  const eligible = [...book.values()]
    .filter((b) => b.kind === KIND_RELIC && b.qty > 0 && b.price >= cfg.minPrice && !own.has(b.bidder.toLowerCase()))
    .sort((a, b) => (b.price !== a.price ? (b.price > a.price ? 1 : -1) : a.id - b.id));
  if (!eligible.length) return { orders: [], top: null, floor: null };
  const top = eligible[0].price;
  const floor = top - cfg.maxGap;
  const levels = eligible.filter((b) => b.price >= floor);
  const left = new Map(levels.map((b) => [b.id, b.qty]));
  const orders = [];
  for (const s of states) {
    if (!s.approved && !cfg.dryRun) continue;
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

const fillGasLimit = (n) => 100000n + 80000n * BigInt(n);

async function sendOrder(o, price) {
  const s = o.state;
  const gross = o.bid.price * BigInt(o.tokenIds.length);
  const net = gross - (gross * BigInt(o.bid.feeBps)) / 10000n;
  const tag = `${short(s.address)} bid #${o.bid.id} @ ${usd(o.bid.price)} x${o.tokenIds.length} -> ~${usd(net)} USDT`;
  if (cfg.dryRun) {
    log(`[dry] ${tag} ids=${o.tokenIds.join(",")}`);
    return null;
  }
  const ids = o.tokenIds.map(String);
  ids.forEach((id) => s.pending.add(id));
  s.tokens = s.tokens.filter((t) => !s.pending.has(t.toString()));
  const b = book.get(o.bid.id);
  if (b && (b.qty -= o.tokenIds.length) <= 0) book.delete(o.bid.id);
  const release = () => ids.forEach((id) => s.pending.delete(id));
  try {
    if (s.nonce === null) s.nonce = await provider.getTransactionCount(s.address, "pending");
    const tx = await s.wallet.sendTransaction({
      to: MARKET,
      data: marketIface.encodeFunctionData("fill", [o.bid.id, o.tokenIds]),
      gasLimit: fillGasLimit(o.tokenIds.length),
      gasPrice: price,
      nonce: s.nonce++,
      chainId: 56,
    });
    log(`sent ${tag} ${tx.hash}`);
    const done = tx.wait().then(
      (rc) => {
        release();
        log(`${rc.status === 1 ? "OK  " : "FAIL"} ${tag} ${tx.hash}`);
        return rc.status === 1;
      },
      (e) => {
        release();
        log(`FAIL ${tag}: ${errMsg(e)}`);
        return false;
      },
    );
    return { done };
  } catch (e) {
    s.nonce = null;
    release();
    log(`send error ${tag}: ${errMsg(e)}`);
    return { done: Promise.resolve(false) };
  }
}

async function sellNow(states) {
  const holding = states.filter((s) => s.tokens.length);
  if (!holding.length) return [];
  const { orders, top, floor } = plan(holding);
  if (!orders.length) {
    if (!top) log("no relic bids in the book");
    return [];
  }
  log(`top ${usd(top)} USDT, selling down to ${usd(floor)}`);
  const price = await gasPrice();
  const byWallet = new Map();
  for (const o of orders) byWallet.set(o.state, [...(byWallet.get(o.state) ?? []), o]);
  const sent = await Promise.all(
    [...byWallet.values()].map(async (os) => {
      const out = [];
      for (const o of os) out.push(await sendOrder(o, price));
      return out;
    }),
  );
  return sent.flat().filter(Boolean).map((r) => r.done);
}

function walletsFromEnv() {
  if (!cfg.keys.length) throw new Error("set PRIVATE_KEYS (comma separated) in env or .env");
  return cfg.keys.map((k) => makeState(new ethers.Wallet(k.startsWith("0x") ? k : `0x${k}`, provider)));
}

async function prepare() {
  const states = walletsFromEnv();
  log(`wallets: ${states.map((s) => s.address).join(", ")}`);
  log(`max gap ${usd(cfg.maxGap)} USDT, min price ${usd(cfg.minPrice)} USDT${cfg.dryRun ? ", DRY RUN" : ""}`);
  await Promise.all(states.map(loadWallet));
  for (const s of states) {
    log(`${s.address} relics ${s.tokens.length}, approved ${s.approved}, BNB ${Number(ethers.formatEther(s.bnb)).toFixed(4)}`);
    if (s.bnb === 0n) log(`warning: ${s.address} has 0 BNB for gas`);
  }
  await approveAll(states);
  return states;
}

async function runSell() {
  const states = await prepare();
  for (let i = 0; i < cfg.rounds; i++) {
    await scanBook();
    const receipts = await sellNow(states);
    if (cfg.dryRun) break;
    const results = await Promise.all(receipts);
    await Promise.all(states.map(loadWallet));
    if (!states.some((s) => s.tokens.length) || (results.length && results.every(Boolean))) break;
    await sleep(1000);
  }
  const left = states.reduce((n, s) => n + s.tokens.length, 0);
  log(left ? `${left} relics left unsold` : "all relics sold");
  if (cfg.revokeAfter && !cfg.dryRun) await revokeAll(states);
}

async function runWatch() {
  const states = await prepare();
  const byAddress = new Map(states.map((s) => [s.address.toLowerCase(), s]));
  const ownTopics = states.map((s) => ethers.zeroPadValue(s.address, 32));

  let busy = false;
  let again = false;
  const trigger = async () => {
    if (busy) {
      again = true;
      return;
    }
    busy = true;
    try {
      do {
        again = false;
        const receipts = await sellNow(states);
        for (const r of receipts)
          r.then((ok) => {
            if (!ok) resync();
          });
      } while (again);
    } catch (e) {
      log(`sell error: ${errMsg(e)}`);
    } finally {
      busy = false;
    }
  };

  const reloadTimers = new Map();
  const reloadWallet = (s) => {
    clearTimeout(reloadTimers.get(s));
    reloadTimers.set(
      s,
      setTimeout(async () => {
        try {
          await loadWallet(s);
          if (s.tokens.length) log(`${short(s.address)} holds ${s.tokens.length} relics`);
          trigger();
        } catch (e) {
          log(`wallet reload error: ${errMsg(e)}`);
        }
      }, 300),
    );
  };

  let syncing = null;
  const resync = () => {
    if (syncing) return syncing;
    syncing = (async () => {
      try {
        await scanBook();
        await Promise.all(states.map(loadWallet));
        trigger();
      } catch (e) {
        log(`resync error: ${errMsg(e)}`);
      } finally {
        syncing = null;
      }
    })();
    return syncing;
  };

  let ws = null;
  let alive = 0;
  const connect = async () => {
    const old = ws;
    if (old) Promise.resolve().then(() => old.destroy()).catch(() => {});
    ws = new ethers.WebSocketProvider(cfg.ws, 56, { staticNetwork: true });
    await ws.on({ address: MARKET }, (l) => {
      const bid = applyMarketLog(l);
      if (bid) {
        log(`new bid #${bid.id} ${usd(bid.price)} x${bid.qty}`);
        trigger();
      }
    });
    await ws.on({ address: RELIC, topics: [TOPIC_TRANSFER, null, ownTopics] }, (l) => {
      const s = byAddress.get(ethers.dataSlice(l.topics[2], 12).toLowerCase());
      if (s) reloadWallet(s);
    });
    await ws.on({ address: RELIC, topics: [TOPIC_TRANSFER, ownTopics] }, (l) => {
      const s = byAddress.get(ethers.dataSlice(l.topics[1], 12).toLowerCase());
      if (s) reloadWallet(s);
    });
    alive = Date.now();
    log(`websocket connected ${cfg.ws}`);
  };

  const reconnect = async () => {
    for (;;) {
      try {
        await connect();
        await resync();
        return;
      } catch (e) {
        log(`websocket connect failed: ${errMsg(e)}`);
        await sleep(3000);
      }
    }
  };

  await reconnect();
  printBook(5);

  setInterval(async () => {
    try {
      await Promise.race([ws.getBlockNumber(), sleep(10000).then(() => Promise.reject(new Error("timeout")))]);
      alive = Date.now();
    } catch (e) {
      if (Date.now() - alive > 20000) {
        log(`websocket dead (${errMsg(e)}), reconnecting`);
        alive = Date.now();
        await reconnect();
      }
    }
  }, 10000);

  setInterval(resync, cfg.resyncMs);
  log("watching for bids...");
}

async function main() {
  log(`rpc ${cfg.rpc}`);
  if (command === "book") {
    await scanBook();
    printBook(30);
    return;
  }
  if (command === "approve") {
    await prepare();
    return;
  }
  if (command === "watch") return runWatch();
  if (command === "sell") return runSell();
  throw new Error(`unknown command "${command}", use: sell | watch | approve | book`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
