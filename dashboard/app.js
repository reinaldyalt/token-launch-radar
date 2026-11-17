// Token Launch Radar, second rendering pass. The snapshot lives in
// window.RADAR (main.ts writes it next to this dashboard as data.js), and
// this script turns it into the ranked board, the filters, the live-token
// table and one detail drawer per protocol. It fetches nothing: everything
// on screen already arrived with the page.
(() => {
  'use strict';

  const SNAP = window.RADAR;
  if (!SNAP) return;

  const mount = document.getElementById('board');
  const ui = {
    q: '', category: 'all', chain: 'all', scope: 'all',
    tab: 'pre-token', sort: 'implied', dir: -1, selected: null,
  };

  const moneyFull = new Intl.NumberFormat('en-US', {
    style: 'currency', currency: 'USD', maximumFractionDigits: 0,
  });

  const usdShort = (value) => {
    if (value === null || value === undefined || !Number.isFinite(value)) return 'n/a';
    const size = Math.abs(value);
    if (size >= 1e9) return '$' + (value / 1e9).toFixed(2) + 'B';
    if (size >= 1e6) return '$' + (value / 1e6).toFixed(1) + 'M';
    if (size >= 1e3) return '$' + Math.round(value / 1e3) + 'K';
    return moneyFull.format(value);
  };

  const pctShort = (value) => {
    if (value === null || value === undefined || !Number.isFinite(value)) return 'n/a';
    return (value > 0 ? '+' : '') + value.toFixed(2) + '%';
  };

  const ageShort = (days) => {
    if (days === null || days === undefined) return 'unknown';
    if (days >= 365) return (days / 365).toFixed(1) + 'y';
    return Math.max(0, Math.round(days)) + 'd';
  };

  // Tiny element builder: tag, attribute map, then any mix of strings,
  // nodes and nested arrays. Keys starting with "on" become listeners.
  const h = (tag, attrs, ...kids) => {
    const node = document.createElement(tag);
    if (attrs) {
      for (const [key, val] of Object.entries(attrs)) {
        if (val === null || val === undefined || val === false) continue;
        if (key === 'class') node.className = val;
        else if (key === 'text') node.textContent = val;
        else if (key === 'html') node.innerHTML = val;
        else if (key.startsWith('on')) node.addEventListener(key.slice(2), val);
        else if (key === 'selected') node.setAttribute('selected', '');
        else node.setAttribute(key, val);
      }
    }
    const push = (kid) => {
      if (kid === null || kid === undefined || kid === false) return;
      if (Array.isArray(kid)) kid.forEach(push);
      else if (typeof kid === 'string') node.appendChild(document.createTextNode(kid));
      else node.appendChild(kid);
    };
    kids.forEach(push);
    return node;
  };

  // The scoring arithmetic, kept in step with board.json: the page derives
  // each row again from the snapshot numbers and compares it with the value
  // the board carries, so a mismatch would show up in the drawer.
  const recompute = (row, model) => {
    const rawGrowth = row.change_7d === null || row.change_7d === undefined ? 0 : row.change_7d;
    const clipped = Math.max(model.growth_floor, Math.min(model.growth_cap, rawGrowth));
    const growthFactor = 1 + (clipped / 100) * model.growth_weight;
    const ageKnown = row.age_days === null || row.age_days === undefined
      ? model.unknown_age_days
      : row.age_days;
    const cappedAge = Math.min(Math.max(ageKnown, 0), model.maturity_days);
    const maturityFactor = model.maturity_floor
      + (cappedAge / model.maturity_days) * model.maturity_range;
    const chainCount = row.chains ? row.chains.length : 1;
    const extraChains = Math.min(Math.max(chainCount - 1, 0), model.chain_max_steps);
    const chainFactor = 1 + extraChains * model.chain_step;
    const raw = row.tvl_usd * row.peer_multiple * model.launch_discount
      * growthFactor * maturityFactor * chainFactor;
    return Math.max(1, Math.round(raw));
  };

  // The seven-step farm plan is derived the same way main.ts derives it:
  // category, chains, TVL and age pick the move, the stake and the hold.
  // No protocol gets a hand-written plan.
  const primaryChain = (proto) => (proto.chains && proto.chains.length > 0
    ? proto.chains[0]
    : 'its main chain');

  const stakeSize = (proto) => {
    if (proto.tvl_usd >= 5e9) return 250;
    if (proto.tvl_usd >= 1e9) return 150;
    if (proto.tvl_usd >= 1e8) return 100;
    return 50;
  };

  const holdSpan = (age) => {
    if (age === null || age === undefined) return 30;
    if (age < 180) return 60;
    if (age < 365) return 45;
    return 30;
  };

  const mainMove = (proto, stake, chain) => {
    const cat = (proto.category || '').toLowerCase();
    const name = proto.name;
    const has = (...words) => words.some((w) => cat.includes(w));
    if (has('risk curator', 'onchain capital allocator', 'curator', 'allocator')) {
      return `Put $${stake} into a ${name} vault on ${chain} and leave the shares untouched for the whole term.`;
    }
    if (has('basis trading')) return `Put $${stake} of USDC into ${name}'s basis vault on ${chain} and leave the position open.`;
    if (has('lend', 'cdp', 'collateral')) return `Supply $${stake} of USDC to ${name} on ${chain} and leave the position open.`;
    if (has('dex', 'yield', 'leveraged farm', 'liquidity manager')) return `Add $${stake} of liquidity to ${name}'s main pool on ${chain} and leave the position open.`;
    if (has('bridge')) return `Bridge $${stake} of USDC to ${chain} through ${name} and put the bridged funds to work in its app.`;
    if (has('staking', 'restak')) return `Stake $${stake} of the chain's staking asset through ${name} and keep the receipt.`;
    if (has('perpetual', 'derivative', 'options')) return `Place $${stake} of USDC as margin on ${name} and open one small hedge.`;
    if (has('prediction')) return `Fund $${stake} and take one market position on ${name}.`;
    if (has('stable')) return `Mint or deposit $${stake} of the stable asset through ${name} on ${chain}.`;
    if (has('rwa')) return `Mint $${stake} of the protocol's yield asset on ${chain} and hold it.`;
    if (has('insurance')) return `Buy $${stake} of cover from ${name} on ${chain} and keep the policy.`;
    if (has('payment', 'card')) return `Spend $${stake} through ${name} on ${chain} and keep the receipts inside the app.`;
    if (has('chain')) return `Bridge $${stake} to the chain ${name} runs on and open its main app at least once a week.`;
    if (has('farm', 'aggregator')) return `Put $${stake} of USDC into ${name}'s top vault on ${chain} and keep the shares.`;
    if (has('index')) return `Buy $${stake} of the ${name} index token on ${chain} and hold it.`;
    return `Put $${stake} of USDC into ${name} on ${chain} and leave the position open.`;
  };

  const weeklyMove = (proto) => {
    const cat = (proto.category || '').toLowerCase();
    const has = (...words) => words.some((w) => cat.includes(w));
    if (has('risk curator', 'allocator', 'curator')) return 'a deposit, a rebalance or a vote in the vault';
    if (has('lend', 'cdp', 'collateral')) return 'a supply, a borrow, a repay or a vote';
    if (has('dex', 'yield', 'farm', 'aggregator')) return 'a swap, a deposit or a vote';
    if (has('perpetual', 'derivative', 'options')) return 'a trade, a deposit or a vote';
    if (has('prediction')) return 'a market position or a vote';
    if (has('rwa')) return 'a mint, a transfer or a vote';
    if (has('payment', 'card')) return 'a spend or a transfer';
    return 'a deposit, a borrow, a swap or a vote';
  };

  const stepLine = (step) => {
    let line = `${step.text} Cost: ${step.cost}. Time: ${step.time}.`;
    if (line.length > 600) line = line.slice(0, 596) + '...';
    if (line.length < 20) line += " Hold the position and check the protocol's own page.";
    return line;
  };

  const planFor = (proto) => {
    const chain = primaryChain(proto);
    const stake = stakeSize(proto);
    const hold = holdSpan(proto.age_days);
    const gas = stake >= 150 ? 8 : 4;
    const drafts = [
      {
        text: 'Start from a fresh wallet that only holds the money you intend to farm, and store its seed phrase offline.',
        cost: 'under $3 of gas for the first transaction',
        time: '5 minutes',
      },
      {
        text: mainMove(proto, stake, chain),
        cost: `$${stake} of capital and about $${gas} of gas`,
        time: '15 minutes to set up',
      },
      {
        text: `Do one qualifying action every week, such as ${weeklyMove(proto)}, so the wallet stays active.`,
        cost: 'about $2 of gas a week',
        time: '10 minutes a week',
      },
      {
        text: `Keep the position in place for at least ${hold} days so the activity shows up in more than one snapshot.`,
        cost: `the $${stake} stays in the position`,
        time: `${hold} days`,
      },
      {
        text: "Before you pull anything out, open the protocol's own points or rewards page and claim only through the link it publishes.",
        cost: 'no fee to check, and never pay to claim',
        time: '10 minutes',
      },
      {
        text: "Re-check the position's risk each month: the contract named on the protocol's own page, the collateral ratio and the exit fee.",
        cost: 'nothing to check',
        time: '10 minutes a month',
      },
      {
        text: 'Record the wallet, the dates and every transaction in a farm log so you can repeat the position or unwind it.',
        cost: 'nothing but the log',
        time: '5 minutes',
      },
    ];
    return drafts.map(stepLine);
  };

  // Filter state lives in the URL hash so a filtered view can be shared.
  const loadHash = () => {
    const raw = window.location.hash.slice(1);
    if (!raw) return;
    const params = new URLSearchParams(raw);
    const q = params.get('q');
    if (q) ui.q = q;
    const picked = params.get('p');
    if (picked) ui.selected = picked;
    const cat = params.get('category');
    if (cat) ui.category = cat;
    const ch = params.get('chain');
    if (ch) ui.chain = ch;
    const scope = params.get('scope');
    if (scope) ui.scope = scope;
    const tab = params.get('tab');
    if (tab) ui.tab = tab;
  };

  const saveHash = () => {
    const params = new URLSearchParams();
    if (ui.q) params.set('q', ui.q);
    if (ui.category !== 'all') params.set('category', ui.category);
    if (ui.chain !== 'all') params.set('chain', ui.chain);
    if (ui.scope !== 'all') params.set('scope', ui.scope);
    if (ui.tab !== 'pre-token') params.set('tab', ui.tab);
    if (ui.selected) params.set('p', ui.selected);
    const next = params.toString();
    const target = next ? '#' + next : window.location.pathname + window.location.search;
    window.history.replaceState(null, '', target);
  };

  const visibleRows = () => {
    const needle = ui.q.trim().toLowerCase();
    return SNAP.rows.filter((row) => {
      if (ui.category !== 'all' && row.category !== ui.category) return false;
      if (ui.chain !== 'all' && !(row.chains || []).includes(ui.chain)) return false;
      if (ui.scope === 'watchlist' && !row.on_watchlist) return false;
      if (ui.scope === 'early' && row.on_watchlist) return false;
      if (!needle) return true;
      const haystack = [row.name, row.slug, row.category, (row.chains || []).join(' ')]
        .join(' ').toLowerCase();
      return haystack.includes(needle);
    });
  };

  const orderedRows = (list) => {
    const key = ui.sort;
    const pick = (row) => {
      if (key === 'name') return row.name.toLowerCase();
      if (key === 'tvl') return row.tvl_usd;
      if (key === 'growth') return row.change_7d === null ? -Infinity : row.change_7d;
      if (key === 'age') return row.age_days === null ? Infinity : row.age_days;
      return row.implied_value_usd;
    };
    return list.slice().sort((a, b) => {
      const av = pick(a);
      const bv = pick(b);
      if (av < bv) return -ui.dir;
      if (av > bv) return ui.dir;
      if (a.slug < b.slug) return -1;
      if (a.slug > b.slug) return 1;
      return 0;
    });
  };

  const topBar = () => h('header', { class: 'top' },
    h('div', { class: 'brand' },
      h('span', { class: 'mark' }),
      h('span', { class: 'brand-name', text: 'Token Launch Radar' })),
    h('div', { class: 'top-meta' },
      h('span', { text: 'Snapshot ' + SNAP.as_of }),
      h('span', { text: 'DefiLlama protocol index' }),
      h('span', { text: SNAP.model_version + ' model' })));

  const introBlock = () => h('section', { class: 'lede' },
    h('div', null,
      h('h1', { text: SNAP.watchlist_size + ' protocols on the watchlist, ordered by implied value' }),
      h('p', null,
        'The watchlist sets the floor: every protocol holding at least $',
        h('b', { text: Math.round(SNAP.floor_usd / 1e6) + 'M' }),
        ' of TVL with no token on record. The early radar adds ',
        h('b', { text: String(SNAP.early_size) }),
        ' further pre-token protocols under that floor, down to the smallest the snapshot tracks. Implied value is a model, not a promise: each row is priced off the tokens its own category peers already trade at.')),
    h('div', { class: 'facts' },
      h('div', { class: 'fact' }, h('span', { text: 'Watchlist protocols covered' }), h('b', { text: SNAP.watchlist_size + ' / ' + SNAP.watchlist_size })),
      h('div', { class: 'fact' }, h('span', { text: 'Pre-token rows scored' }), h('b', { text: String(SNAP.board_size) })),
      h('div', { class: 'fact' }, h('span', { text: 'Early rows under the floor' }), h('b', { text: String(SNAP.early_size) })),
      h('div', { class: 'fact' }, h('span', { text: 'Live-token protocols aside' }), h('b', { text: String(SNAP.live_size) })),
      h('div', { class: 'fact' }, h('span', { text: 'Global peer multiple (mcap / TVL)' }), h('b', { text: String(SNAP.global_peer_multiple) }))));

  const topCards = () => {
    const cards = SNAP.rows.slice(0, 3).map((row) => h('button', {
      type: 'button', class: 'leader', onclick: () => showProtocol(row.slug),
    },
      h('span', { class: 'rank-tag', text: 'Rank ' + row.rank + ' · ' + (row.on_watchlist ? 'Watchlist' : 'Early') }),
      h('b', { text: row.name }),
      h('span', { class: 'implied', text: usdShort(row.implied_value_usd) + ' implied' }),
      h('span', { class: 'sub', text: (row.category || 'Other') + ' · ' + usdShort(row.tvl_usd) + ' TVL · ' + pctShort(row.change_7d) + ' in 7d' })));
    return h('div', { class: 'leaders' }, cards);
  };

  const filterBar = () => {
    const categories = [...new Set(SNAP.rows.map((r) => r.category || 'Other'))].sort();
    const chains = [...new Set(SNAP.rows.flatMap((r) => r.chains || []))].sort();
    const search = h('input', {
      type: 'search', id: 'q', placeholder: 'Search name, category or chain',
      value: ui.q, 'aria-label': 'Search the board',
    });
    search.addEventListener('input', () => { ui.q = search.value; saveHash(); paint(); });
    const catSel = h('select', { id: 'category', 'aria-label': 'Filter by category' },
      h('option', { value: 'all', text: 'All categories' }),
      categories.map((c) => h('option', { value: c, text: c, selected: c === ui.category })));
    catSel.addEventListener('change', () => { ui.category = catSel.value; saveHash(); paint(); });
    const chainSel = h('select', { id: 'chain', 'aria-label': 'Filter by chain' },
      h('option', { value: 'all', text: 'All chains' }),
      chains.map((c) => h('option', { value: c, text: c, selected: c === ui.chain })));
    chainSel.addEventListener('change', () => { ui.chain = chainSel.value; saveHash(); paint(); });
    const scopeSel = h('select', { id: 'scope', 'aria-label': 'Watchlist or early' },
      h('option', { value: 'all', text: 'Watchlist + early' }),
      h('option', { value: 'watchlist', text: 'Watchlist only', selected: ui.scope === 'watchlist' }),
      h('option', { value: 'early', text: 'Early only', selected: ui.scope === 'early' }));
    scopeSel.addEventListener('change', () => { ui.scope = scopeSel.value; saveHash(); paint(); });
    const preBtn = h('button', {
      type: 'button', 'aria-pressed': ui.tab === 'pre-token' ? 'true' : 'false',
      text: 'Pre-token', onclick: () => { ui.tab = 'pre-token'; paint(); },
    });
    const liveBtn = h('button', {
      type: 'button', 'aria-pressed': ui.tab === 'live' ? 'true' : 'false',
      text: 'Live token', onclick: () => { ui.tab = 'live'; paint(); },
    });
    const countText = ui.tab === 'pre-token'
      ? visibleRows().length + ' rows shown'
      : SNAP.live.length + ' live-token protocols';
    return h('div', { class: 'controls' },
      h('div', { class: 'field' }, h('label', { for: 'q', text: 'Search' }), search),
      h('div', { class: 'field' }, h('label', { for: 'category', text: 'Category' }), catSel),
      h('div', { class: 'field' }, h('label', { for: 'chain', text: 'Chain' }), chainSel),
      h('div', { class: 'field' }, h('label', { for: 'scope', text: 'Scope' }), scopeSel),
      h('div', { class: 'field' }, h('span', { class: 'sub', text: 'Token status' }), h('div', { class: 'tabs' }, preBtn, liveBtn)),
      h('span', { class: 'count', text: countText }));
  };

  const sortCell = (key, label) => h('th', { scope: 'col' },
    h('button', {
      type: 'button',
      onclick: () => {
        if (ui.sort === key) ui.dir = -ui.dir;
        else { ui.sort = key; ui.dir = -1; }
        paint();
      },
    },
      label,
      ui.sort === key ? h('span', { 'aria-hidden': 'true', text: ui.dir < 0 ? ' v' : ' ^' }) : null));

  const preTokenTable = () => {
    const list = orderedRows(visibleRows());
    if (list.length === 0) {
      return h('div', { class: 'panel' }, h('div', { class: 'empty' },
        h('h2', { text: 'No protocol matches that filter' }),
        h('p', { text: 'Clear the search or pick another category to see the board again.' }),
        h('button', {
          class: 'button primary', type: 'button', text: 'Clear filters',
          onclick: () => { ui.q = ''; ui.category = 'all'; ui.chain = 'all'; ui.scope = 'all'; saveHash(); paint(); },
        })));
    }
    const top = list[0].implied_value_usd || 1;
    const tbody = h('tbody');
    for (const row of list) {
      const growth = row.change_7d === null ? 'n/a' : pctShort(row.change_7d);
      const growthClass = row.change_7d === null ? '' : row.change_7d >= 0 ? 'pos' : 'neg';
      const chainLabel = row.chains && row.chains.length
        ? row.chains.slice(0, 2).join(', ')
        : 'an unnamed chain';
      const barWidth = Math.max(3, Math.round((row.implied_value_usd / top) * 100));
      tbody.appendChild(h('tr', {
        'data-selected': ui.selected === row.slug ? 'true' : 'false',
        tabindex: '0',
        onclick: () => showProtocol(row.slug),
        onkeydown: (e) => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); showProtocol(row.slug); }
        },
      },
        h('td', { class: 'num' }, h('span', { class: 'rank-badge' + (row.rank <= 3 ? ' top' : ''), text: String(row.rank) })),
        h('td', null, h('div', { class: 'name' },
          h('span', null, h('b', { text: row.name }), h('span', { class: 'tag' + (row.on_watchlist ? '' : ' early'), text: row.on_watchlist ? 'watchlist' : 'early' })),
          h('span', { class: 'sub', text: (row.category || 'Other') + ' on ' + chainLabel }))),
        h('td', { class: 'num', text: usdShort(row.tvl_usd) }),
        h('td', { class: 'num ' + growthClass, text: growth }),
        h('td', { class: 'num', text: ageShort(row.age_days) }),
        h('td', null, h('div', { class: 'implied' },
          h('div', { class: 'bar', 'aria-hidden': 'true' }, h('i', { style: 'width:' + barWidth + '%' })),
          h('span', { class: 'num', text: usdShort(row.implied_value_usd) }))),
        h('td', null, h('span', { class: 'status', text: 'no token' }))));
    }
    return h('div', { class: 'panel' },
      h('div', { class: 'table-wrap' },
        h('table', null,
          h('caption', { class: 'sub', text: 'Pre-token protocols, strongest implied value first. Select a row for its model and farm plan.' }),
          h('thead', null, h('tr', null,
            sortCell('implied', 'Rank'),
            sortCell('name', 'Protocol'),
            sortCell('tvl', 'TVL'),
            sortCell('growth', '7d'),
            sortCell('age', 'Age'),
            sortCell('implied', 'Implied value'),
            h('th', { scope: 'col', text: 'Token' }))),
          tbody)));
  };

  const liveTokenTable = () => {
    const tbody = h('tbody');
    for (const row of SNAP.live) {
      const chainLabel = row.chains && row.chains.length
        ? row.chains.slice(0, 2).join(', ')
        : 'an unnamed chain';
      const tone = row.change_7d !== null && row.change_7d >= 0 ? 'pos' : 'neg';
      tbody.appendChild(h('tr', null,
        h('td', { class: 'num', text: 'live' }),
        h('td', null, h('div', { class: 'name' },
          h('b', { text: row.name }),
          h('span', { class: 'sub', text: (row.category || 'Other') + ' on ' + chainLabel }))),
        h('td', { class: 'num', text: usdShort(row.tvl_usd) }),
        h('td', { class: 'num ' + tone, text: pctShort(row.change_7d) }),
        h('td', { class: 'num', text: usdShort(row.mcap_usd) }),
        h('td', null, h('span', { class: 'status', text: 'already trades' }))));
    }
    return h('div', { class: 'panel' },
      h('div', { class: 'table-wrap' },
        h('table', null,
          h('caption', { class: 'sub', text: 'Token live: these protocols already trade, so their market cap is a fact, not a model. They sit outside the pre-token ranking, and they are the peers the model prices the board against.' }),
          h('thead', null, h('tr', null,
            h('th', { scope: 'col', text: 'Status' }),
            h('th', { scope: 'col', text: 'Protocol' }),
            h('th', { scope: 'col', text: 'TVL' }),
            h('th', { scope: 'col', text: '7d' }),
            h('th', { scope: 'col', text: 'Market cap' }),
            h('th', { scope: 'col', text: 'Token' }))),
          tbody)));
  };

  const formulaPanel = () => {
    const model = SNAP.model;
    const formula = `implied = round( tvl_usd x peer_multiple x ${model.launch_discount} x (1 + clamp(change_7d, ${model.growth_floor}, ${model.growth_cap}) / 100 x ${model.growth_weight}) x (${model.maturity_floor} + min(age_days, ${model.maturity_days}) / ${model.maturity_days} x ${model.maturity_range}) x (1 + min(chains - 1, ${model.chain_max_steps}) x ${model.chain_step}) )`;
    return h('section', { class: 'panel model' },
      h('h2', { text: 'How implied value is computed' }),
      h('p', { class: 'sub', text: 'One function of the snapshot figures scores every row. No protocol name is special-cased, and no row is hand-picked.' }),
      h('div', { class: 'formula' }, formula),
      h('ul', null,
        h('li', null, h('b', { text: 'Peer multiple. ' }), `For each category, the median market-cap-to-TVL ratio of its live-token protocols (at least ${model.peer_min_count} peers), blended toward the global median of ${SNAP.global_peer_multiple} when a category has fewer peers, clamped to [${model.peer_floor}, ${model.peer_cap}]. A category whose tokens trade richly prices its pre-token peers richly.`),
        h('li', null, h('b', { text: 'Launch discount. ' }), `A token launches below its mature peers, so the peer multiple is halved (${model.launch_discount}).`),
        h('li', null, h('b', { text: 'Growth and maturity. ' }), `Seven-day TVL growth moves the value up or down; age is the time since the protocol was first listed, the best record of how long it has run with no token, and an unlisted age uses ${model.unknown_age_days} days.`),
        h('li', null, h('b', { text: 'Chain reach. ' }), `Each extra chain adds ${model.chain_step * 100}% to the value, up to ${model.chain_max_steps} extra chains: a protocol live on many chains reaches more farmers.`),
        h('li', null, h('b', { text: 'What is left out. ' }), 'Wrapped, staked and bridged products, exchanges and versioned pools are excluded by the watchlist rule itself, so the board never ranks a product whose underlying token already trades. "No token" means the record carries none, never that the protocol has none.')));
  };

  const pageFoot = () => h('footer', { class: 'foot' },
    h('span', { text: 'Source: ' + SNAP.source }),
    h('span', { text: 'Implied value is this dashboard\u2019s own estimate from the snapshot\u2019s figures. It is not a price, not a prediction that a token will launch, and not financial advice.' }));

  const sheet = h('dialog', { class: 'detail', id: 'detail', 'aria-labelledby': 'detail-title' });
  sheet.addEventListener('close', () => { ui.selected = null; saveHash(); });

  const showProtocol = (slug) => {
    const row = SNAP.rows.find((r) => r.slug === slug);
    if (!row) return;
    ui.selected = slug;
    saveHash();
    sheet.textContent = '';
    const steps = planFor(row);
    let peerNote;
    if (row.peer_count >= SNAP.model.peer_min_count) {
      peerNote = `median of ${row.peer_count} live ${row.category || 'Other'} peers`;
    } else if (row.peer_count > 0) {
      peerNote = `blended from ${row.peer_count} live peer${row.peer_count > 1 ? 's' : ''} and the global median`;
    } else {
      peerNote = 'global median, no live peer in this category';
    }
    const chainLabel = row.chains && row.chains.length ? row.chains.join(', ') : 'an unnamed chain';
    const equationRows = [
      ['TVL', usdShort(row.tvl_usd)],
      [`Peer multiple (${peerNote})`, row.peer_multiple + 'x'],
      ['Launch discount', 'x' + SNAP.model.launch_discount],
      ['Seven-day growth', pctShort(row.change_7d) + ' -> x' + row.growth_multiplier],
      ['Age with no token', ageShort(row.age_days) + ' -> x' + row.maturity_multiplier],
      [`Chains (${row.chains ? row.chains.length : 0})`, 'x' + row.chain_multiplier],
    ];
    sheet.appendChild(h('div', { class: 'detail-head' },
      h('div', null,
        h('span', { class: 'brand-name', text: 'Rank ' + row.rank + ' of ' + SNAP.board_size + ' · ' + (row.on_watchlist ? 'Watchlist' : 'Early') }),
        h('h2', { id: 'detail-title', text: row.name }),
        h('p', { class: 'sub', text: (row.category || 'Other') + ' on ' + chainLabel })),
      h('button', { class: 'close', type: 'button', 'aria-label': 'Close details', text: 'Close', onclick: () => sheet.close() })));
    const again = recompute(row, SNAP.model);
    const matchNote = again === row.implied_value_usd
      ? ', the same number board.json carries.'
      : ', which differs from the board: the data would be stale.';
    sheet.appendChild(h('section', { class: 'detail-section' },
      h('h3', { text: 'Implied value' }),
      h('div', { class: 'equation' },
        equationRows.map(([label, value]) => h('div', null,
          h('span', { text: label }),
          h('b', { class: 'num', text: value }))),
        h('div', { class: 'total' },
          h('span', { text: 'Implied value' }),
          h('b', { class: 'num', text: usdShort(row.implied_value_usd) }))),
      h('p', { class: 'sub', text: `Model ${SNAP.model_version}: the same function scores every protocol. The page recomputes this row as ${usdShort(again)}${matchNote} This is an estimate, not a price.` })));
    sheet.appendChild(h('section', { class: 'detail-section' },
      h('h3', { text: 'Farm plan' }),
      h('ol', { class: 'steps' }, steps.map((line) => {
        const cut = line.indexOf(' Cost: ');
        const action = cut >= 0 ? line.slice(0, cut) : line;
        const tail = cut >= 0 ? line.slice(cut + 1) : '';
        return h('li', null, h('b', { text: action }), h('span', { class: 'cost', text: tail }));
      }))));
    if (typeof sheet.showModal === 'function') {
      if (!sheet.open) sheet.showModal();
    } else {
      sheet.setAttribute('open', '');
    }
  };

  const paint = () => {
    mount.textContent = '';
    const shell = h('div', { class: 'shell' });
    shell.appendChild(topBar());
    shell.appendChild(introBlock());
    shell.appendChild(topCards());
    shell.appendChild(filterBar());
    shell.appendChild(ui.tab === 'pre-token' ? preTokenTable() : liveTokenTable());
    if (ui.tab === 'pre-token') shell.appendChild(formulaPanel());
    shell.appendChild(pageFoot());
    mount.appendChild(shell);
    mount.setAttribute('aria-busy', 'false');
    if (!sheet.isConnected) mount.appendChild(sheet);
    if (ui.selected) showProtocol(ui.selected);
  };

  loadHash();
  paint();
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && sheet.open) sheet.close();
  });
})();
