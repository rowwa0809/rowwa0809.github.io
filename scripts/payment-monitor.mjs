const wallet = process.env.WALLET;
const repo = process.env.GITHUB_REPOSITORY;
const token = process.env.GITHUB_TOKEN;
const start = Date.parse(process.env.START_AT) / 1000;
const [owner, name] = repo.split('/');
const rpc = 'https://api.mainnet-beta.solana.com';

async function rpcCall(method, params) {
  const response = await fetch(rpc, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const body = await response.json();
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}

async function github(path, options = {}) {
  let response;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    response = await fetch(`https://api.github.com${path}`, {
      ...options,
      headers: {
        accept: 'application/vnd.github+json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        'user-agent': 'solana-demo-rescue-monitor',
        'x-github-api-version': '2022-11-28',
        ...options.headers,
      },
    });
    if (response.ok || (response.status !== 429 && response.status < 500)) break;
    if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** attempt));
  }
  if (!response.ok) throw new Error(`GitHub ${response.status}`);
  return response.status === 204 ? null : response.json();
}

const balance = await rpcCall('getBalance', [wallet, { commitment: 'confirmed' }]);
const signatures = await rpcCall('getSignaturesForAddress', [wallet, { limit: 20, commitment: 'confirmed' }]);
const recent = signatures.filter((item) => item.blockTime >= start && !item.err);
const transactions = await Promise.all(recent.map((item) => rpcCall('getTransaction', [item.signature, {
  commitment: 'confirmed', maxSupportedTransactionVersion: 0,
}])));
const inbound = recent.flatMap((item, i) => {
  const tx = transactions[i];
  const keys = tx?.transaction?.message?.accountKeys || [];
  const index = keys.findIndex((key) => (typeof key === 'string' ? key : key.pubkey) === wallet);
  if (index < 0) return [];
  const lamports = tx.meta.postBalances[index] - tx.meta.preBalances[index];
  return lamports > 0 ? [{ ...item, sol: lamports / 1e9 }] : [];
});

let issues = [];
let issueApiError = '';
try {
  issues = await github(`/repos/${owner}/${name}/issues?state=open&per_page=100`);
} catch (error) {
  issueApiError = error.message;
  console.warn(`Order check unavailable: ${issueApiError}`);
}
const orders = issues.filter((issue) => !issue.pull_request && issue.number !== 1 && issue.title.startsWith('[RESCUE]'));
const rows = inbound.length
  ? inbound.map((tx) => `- +${tx.sol.toFixed(9).replace(/0+$/, '').replace(/\.$/, '')} SOL · [transaction](https://solscan.io/tx/${tx.signature})`).join('\n')
  : '- None since baseline';
const marker = '<!-- autonomous-revenue-monitor -->';
const orderCount = issueApiError ? `unavailable this run (${issueApiError})` : orders.length;
const body = `${marker}\n## Autonomous revenue monitor\n\n- Last check: ${new Date().toISOString()}\n- Wallet balance: ${(balance.value / 1e9).toFixed(9).replace(/0+$/, '').replace(/\.$/, '')} SOL\n- Matched open orders: ${orderCount}\n- Confirmed inbound transfers after baseline: ${inbound.length}\n\n${rows}\n\nA transfer counts as revenue only after it is matched to an accepted order.`;
console.log(body);
if (process.env.DRY_RUN !== '1') {
  try {
    const comments = await github(`/repos/${owner}/${name}/issues/1/comments?per_page=100`);
    const existing = comments.find((comment) => comment.body.includes(marker));
    await github(existing ? `/repos/${owner}/${name}/issues/comments/${existing.id}` : `/repos/${owner}/${name}/issues/1/comments`, {
      method: existing ? 'PATCH' : 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ body }),
    });
  } catch (error) {
    console.warn(`Monitor comment deferred: ${error.message}`);
  }
}
