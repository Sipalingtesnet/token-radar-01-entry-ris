// ---------------------------------------------------------------------------
// Token Launch Radar — dashboard behaviour.
//
// Original vanilla JavaScript: one IIFE, 'use strict', no imports, no network,
// no framework. Reads the sealed payload from window.TOKENRADAR (written by
// ../data.js) and renders everything with document.createElement + textContent,
// so no data value is ever parsed as HTML.
//
// Layout of this file:
//   1. data guard            5. controls
//   2. DOM + format helpers  6. board table
//   3. derived lookups       7. detail panel
//   4. static shell          8. assembly + first render
// ---------------------------------------------------------------------------
(function () {
  'use strict';

  const board = document.getElementById('board');
  if (!board) return;

  // --- 1. data guard --------------------------------------------------------
  // Without the bootstrap script there is nothing to render: say so plainly.
  const data = window.TOKENRADAR;
  if (!data || !Array.isArray(data.rows)) {
    const line = document.createElement('p');
    line.textContent = 'The data file (data.js) is missing, so there is no board to show.';
    board.appendChild(line);
    board.setAttribute('aria-busy', 'false');
    return;
  }

  // --- 2. DOM + format helpers ----------------------------------------------

  /** Create an element with an optional class and text. Text goes through
   *  textContent only — never innerHTML — so payload strings stay inert. */
  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  /** Compact money: $1.23B / $45.6M / $789K / $123. 'n/a' for non-numbers. */
  function money(n) {
    if (typeof n !== 'number' || !Number.isFinite(n)) return 'n/a';
    const sign = n < 0 ? '-' : '';
    const v = Math.abs(n);
    if (v >= 1e9) return sign + '$' + (v / 1e9).toFixed(2) + 'B';
    if (v >= 1e6) return sign + '$' + (v / 1e6).toFixed(1) + 'M';
    if (v >= 1e3) return sign + '$' + Math.round(v / 1e3) + 'K';
    return sign + '$' + Math.round(v);
  }

  /** Signed 7-day percent, one decimal; null becomes 'n/a'. */
  function pct(n) {
    if (typeof n !== 'number' || !Number.isFinite(n)) return 'n/a';
    return (n >= 0 ? '+' : '') + n.toFixed(1) + '%';
  }

  /** Track record from an age in days: '3.2y' / '210d' / 'unknown'. */
  function ageLabel(days) {
    if (typeof days !== 'number' || !Number.isFinite(days) || days < 0) return 'unknown';
    return days >= 365 ? (days / 365).toFixed(1) + 'y' : Math.round(days) + 'd';
  }

  /** Null categories read as 'Uncategorised', exactly as the model groups them. */
  function catLabel(category) {
    return category === null || category === undefined ? 'Uncategorised' : category;
  }

  /** First two chain names, then '+n' when there are more. */
  function chainsLabel(chains) {
    if (!Array.isArray(chains) || chains.length === 0) return 'n/a';
    const head = chains.slice(0, 2).join(', ');
    return chains.length > 2 ? head + ' +' + (chains.length - 2) : head;
  }

  /** Implied value over TVL to two decimals; guarded against zero TVL. */
  function timesTvl(row) {
    if (!(row.tvl_usd > 0)) return 'n/a';
    return (row.implied_value_usd / row.tvl_usd).toFixed(2);
  }

  // --- 3. derived lookups -----------------------------------------------------

  const rows = data.rows;
  const bySlug = new Map(rows.map((r) => [r.slug, r]));
  const topRow = rows.find((r) => r.rank === 1) || null;
  const watchlistCovered = rows.filter((r) => r.watchlist).length;

  // Distinct filter options, built from the rows themselves.
  const categories = [...new Set(rows.map((r) => catLabel(r.category)))].sort();
  const chains = [...new Set(rows.flatMap((r) => (Array.isArray(r.chains) ? r.chains : [])))].sort();

  // Every sort is descending; nulls sink to the bottom via finite sentinels,
  // and ties fall back to board rank so the order is always deterministic.
  const SORTS = [
    { key: 'implied', label: 'Sort: Implied value', value: (r) => r.implied_value_usd },
    { key: 'tvl', label: 'Sort: TVL', value: (r) => r.tvl_usd },
    { key: 'change', label: 'Sort: 7-day change', value: (r) => (r.change_7d === null ? -1e12 : r.change_7d) },
    { key: 'age', label: 'Sort: Track record (age)', value: (r) => (r.age_days === null ? -1 : r.age_days) },
  ];

  // The whole UI state. Control changes only re-render the table + count line;
  // the current selection is deliberately left alone.
  const state = {
    search: '',
    category: '',
    chain: '',
    watchlistOnly: false,
    sort: 'implied',
    selected: null,
  };

  /** Rows passing every active filter, in the chosen descending order. */
  function visibleRows() {
    const q = state.search.trim().toLowerCase();
    const sort = SORTS.find((s) => s.key === state.sort) || SORTS[0];
    return rows
      .filter((r) => {
        if (q && !r.name.toLowerCase().includes(q) && !r.slug.toLowerCase().includes(q)) return false;
        if (state.category && catLabel(r.category) !== state.category) return false;
        if (state.chain && !(Array.isArray(r.chains) && r.chains.includes(state.chain))) return false;
        if (state.watchlistOnly && !r.watchlist) return false;
        return true;
      })
      .sort((a, b) => sort.value(b) - sort.value(a) || a.rank - b.rank);
  }

  // --- 4. static shell ----------------------------------------------------------

  /** Masthead: brand line, title, and the sealed-snapshot provenance line. */
  function buildMasthead() {
    const masthead = el('header', 'masthead');
    masthead.appendChild(el('span', 'brand', 'MAKE.FUN BOUNTY · TOKEN-RADAR-01'));
    masthead.appendChild(el('h1', '', 'Token Launch Radar'));
    const c = data.counts;
    masthead.appendChild(el('p', 'asof',
      'Sealed DefiLlama snapshot of ' + data.asOf +
      ' · ' + c.protocols + ' protocols scanned' +
      ' · ' + c.candidates + ' pre-token candidates ranked' +
      ' · ' + c.watchlist + ' on the house watchlist'));
    return masthead;
  }

  /** One stat card: big value over a small uppercase label. */
  function stat(value, label) {
    const card = el('div', 'stat');
    card.append(el('b', '', value), el('span', '', label));
    return card;
  }

  function buildStats() {
    const stats = el('div', 'stats');
    stats.appendChild(stat(String(data.counts.protocols), 'Protocols scanned'));
    stats.appendChild(stat(String(data.counts.candidates), 'Pre-token candidates'));
    stats.appendChild(stat(watchlistCovered + ' / ' + data.counts.watchlist, 'Watchlist covered'));
    stats.appendChild(stat(topRow ? money(topRow.implied_value_usd) : 'n/a', "Board's top implied value"));
    return stats;
  }

  /** Model strip: the summary plus one chip per category multiple. */
  function buildModelStrip() {
    const strip = el('section', 'model-strip');
    strip.appendChild(el('h2', '', 'How the implied value works'));
    strip.appendChild(el('p', 'model-summary', data.model.summary));
    const chips = el('div', 'mult-chips');
    for (const entry of data.model.categoryMultiples) {
      chips.appendChild(el('span', 'chip',
        catLabel(entry.category) + ' ×' + entry.multiple.toFixed(2) + ' · n=' + entry.samples));
    }
    strip.appendChild(chips);
    return strip;
  }

  /** Footer: the two honesty lines every reader of this board should see. */
  function buildFooter() {
    const foot = el('footer', 'foot');
    foot.appendChild(el('p', '',
      'The implied values on this board are this entry’s own model claims — not make.fun’s, ' +
      'and not a promise that any protocol will launch a token.'));
    foot.appendChild(el('p', '',
      'A protocol listed here records no token in the sealed snapshot. That is DefiLlama’s record ' +
      'at the snapshot date, not proof that no token exists.'));
    return foot;
  }

  // --- 5. controls ----------------------------------------------------------------

  /** A labelled control column: <label for> + field, joined by an id. */
  function ctl(labelText, id, field) {
    const column = el('div', 'ctl');
    const label = el('label', '', labelText);
    label.htmlFor = id;
    field.id = id;
    column.append(label, field);
    return column;
  }

  /** A <select> from [value, text] pairs. */
  function selectWith(options) {
    const select = el('select');
    for (const [value, text] of options) {
      const option = el('option', '', text);
      option.value = value;
      select.appendChild(option);
    }
    return select;
  }

  /** Search, category, chain, watchlist-only and sort. Every change re-renders
   *  just the table and the count line — nothing else is cleared. */
  function buildControls() {
    const controls = el('div', 'controls');

    const search = el('input');
    search.type = 'search';
    search.placeholder = 'Name or slug…';
    search.addEventListener('input', () => {
      state.search = search.value;
      renderBoard();
    });
    controls.appendChild(ctl('Search', 'ctl-search', search));

    const category = selectWith([['', 'All categories'], ...categories.map((c) => [c, c])]);
    category.addEventListener('change', () => {
      state.category = category.value;
      renderBoard();
    });
    controls.appendChild(ctl('Category', 'ctl-category', category));

    const chain = selectWith([['', 'All chains'], ...chains.map((c) => [c, c])]);
    chain.addEventListener('change', () => {
      state.chain = chain.value;
      renderBoard();
    });
    controls.appendChild(ctl('Chain', 'ctl-chain', chain));

    const check = el('label', 'check');
    const box = el('input');
    box.type = 'checkbox';
    box.id = 'ctl-watchlist';
    box.addEventListener('change', () => {
      state.watchlistOnly = box.checked;
      renderBoard();
    });
    check.append(box, document.createTextNode('Watchlist only'));
    controls.appendChild(check);

    const sort = selectWith(SORTS.map((s) => [s.key, s.label]));
    sort.addEventListener('change', () => {
      state.sort = sort.value;
      renderBoard();
    });
    controls.appendChild(ctl('Sort order', 'ctl-sort', sort));

    return controls;
  }

  // --- 6. board table ---------------------------------------------------------------

  const COLUMNS = ['Rank', 'Protocol', 'Category', 'Chains', 'TVL', '7d', 'Track record', 'Implied value', '×TVL'];
  const NUMERIC_COLUMNS = new Set([0, 4, 5, 6, 7, 8]); // right-aligned, monospace

  const countLine = el('p', 'count-line');
  let tbody = null; // assigned by buildTable, refilled by renderBoard

  /** The scroll wrapper, table and sticky header. The body starts empty. */
  function buildTable() {
    const scroll = el('div', 'table-scroll');
    const table = el('table', 'board-table');
    const headRow = el('tr');
    COLUMNS.forEach((title, i) => {
      const th = el('th', NUMERIC_COLUMNS.has(i) ? 'num' : '', title);
      th.scope = 'col';
      headRow.appendChild(th);
    });
    const thead = el('thead');
    thead.appendChild(headRow);
    tbody = el('tbody');
    table.append(thead, tbody);
    scroll.appendChild(table);
    return scroll;
  }

  /** One board row. Watchlist rows get the amber edge and a star. */
  function boardRow(row) {
    const tr = el('tr', row.watchlist ? 'wl-row' : '');
    tr.dataset.slug = row.slug;
    tr.tabIndex = 0; // rows are selectable with the keyboard too

    tr.appendChild(el('td', 'num rank', String(row.rank)));

    const name = el('td', '', row.name);
    if (row.watchlist) name.appendChild(el('span', 'star', ' ★'));
    tr.appendChild(name);

    tr.appendChild(el('td', '', catLabel(row.category)));
    tr.appendChild(el('td', '', chainsLabel(row.chains)));
    tr.appendChild(el('td', 'num', money(row.tvl_usd)));

    const change = el('td', 'num', pct(row.change_7d));
    if (typeof row.change_7d === 'number' && Number.isFinite(row.change_7d)) {
      change.classList.add(row.change_7d < 0 ? 'neg' : 'pos');
    }
    tr.appendChild(change);

    tr.appendChild(el('td', 'num', ageLabel(row.age_days)));
    tr.appendChild(el('td', 'num', money(row.implied_value_usd)));
    tr.appendChild(el('td', 'num', timesTvl(row)));
    return tr;
  }

  /** Re-render the tbody and the count line from the current filters + sort. */
  function renderBoard() {
    const visible = visibleRows();
    countLine.textContent = 'Showing ' + visible.length + ' of ' + rows.length + ' ranked protocols';
    tbody.replaceChildren();
    if (visible.length === 0) {
      const tr = el('tr');
      const td = el('td', '', 'No protocols match these filters.');
      td.colSpan = COLUMNS.length;
      tr.appendChild(td);
      tbody.appendChild(tr);
      return;
    }
    for (const row of visible) tbody.appendChild(boardRow(row));
  }

  // --- 7. detail panel ----------------------------------------------------------------

  const detailHost = el('div'); // holds the .detail section when a row is selected

  /** One key/value pair inside the detail grid. */
  function kv(grid, key, value) {
    const pair = el('div', 'kv');
    pair.append(el('dt', '', key), el('dd', '', value));
    grid.appendChild(pair);
  }

  /** One arithmetic row of the breakdown table; the final row is .total. */
  function breakdownRow(body, label, value, isTotal) {
    const tr = el('tr', isTotal ? 'total' : '');
    const th = el('th', '', label);
    th.scope = 'row';
    tr.append(th, el('td', '', value));
    body.appendChild(tr);
  }

  /** Rebuild the detail panel for the selected row (or empty it when none). */
  function renderDetail() {
    detailHost.replaceChildren();
    const row = state.selected === null ? null : bySlug.get(state.selected);
    if (!row) return;

    const panel = el('section', 'detail');

    // Title with the badges inline — the stylesheet lays the h2 out as a flex row.
    const h2 = el('h2', '', row.name);
    if (row.watchlist) h2.appendChild(el('span', 'badge badge-watchlist', 'House watchlist'));
    h2.appendChild(el('span', 'badge badge-cat', catLabel(row.category)));
    panel.appendChild(h2);

    const close = el('button', 'close-btn', 'Close');
    close.type = 'button';
    close.addEventListener('click', () => {
      state.selected = null;
      renderDetail();
    });
    panel.appendChild(close);

    // Key facts, straight from the sealed record.
    const grid = el('dl', 'detail-grid');
    kv(grid, 'TVL', money(row.tvl_usd));
    kv(grid, '7-day change', pct(row.change_7d));
    kv(grid, 'Track record', ageLabel(row.age_days) + (row.listed_at ? ' · listed ' + row.listed_at : ''));
    kv(grid, 'Chains', Array.isArray(row.chains) && row.chains.length > 0 ? row.chains.join(', ') : 'n/a');
    kv(grid, 'Board rank', String(row.rank));
    kv(grid, 'Implied value', money(row.implied_value_usd));
    panel.appendChild(grid);

    // The model's arithmetic, factor by factor, so the claim can be audited.
    const breakdown = el('div', 'breakdown');
    const bBody = el('tbody');
    const base = row.tvl_usd * row.multiple;
    breakdownRow(bBody, 'TVL × category multiple',
      money(row.tvl_usd) + ' × ' + row.multiple.toFixed(2) + ' = ' + money(base));
    breakdownRow(bBody, '× growth factor', row.growth_factor.toFixed(2));
    breakdownRow(bBody, '× maturity factor', row.maturity_factor.toFixed(2));
    breakdownRow(bBody, '× breadth factor', row.breadth_factor.toFixed(2));
    breakdownRow(bBody, 'Implied value', money(row.implied_value_usd), true);
    const bTable = el('table');
    bTable.appendChild(bBody);
    breakdown.appendChild(bTable);
    panel.appendChild(breakdown);

    // The concrete farm plan for this protocol.
    panel.appendChild(el('h3', '', 'How to farm it'));
    const farm = el('ol', 'farm');
    for (const step of row.farm_steps || []) farm.appendChild(el('li', '', step));
    panel.appendChild(farm);

    // The standing caveat, muted like the other provenance lines.
    panel.appendChild(el('p', 'asof',
      row.name + ' records no token in the snapshot; the implied value is this board’s own model claim, not a prediction.'));

    detailHost.appendChild(panel);
  }

  /** Select a protocol by slug; optionally scroll the fresh panel into view. */
  function select(slug, scroll) {
    state.selected = slug;
    renderDetail();
    if (scroll && detailHost.firstChild) {
      detailHost.firstChild.scrollIntoView({ block: 'nearest' });
    }
  }

  // --- 8. assembly + first render ------------------------------------------------------

  const wrap = el('div', 'wrap');
  wrap.append(
    buildMasthead(),
    buildStats(),
    buildModelStrip(),
    buildControls(),
    countLine,
    buildTable(),
    detailHost,
    buildFooter(),
  );
  board.appendChild(wrap);
  board.setAttribute('aria-busy', 'false');

  // Row selection is delegated to the tbody: click, or Enter/Space on a focused row.
  function selectFromEvent(event) {
    const tr = event.target.closest('tr[data-slug]');
    if (tr) select(tr.dataset.slug, true);
  }
  tbody.addEventListener('click', selectFromEvent);
  tbody.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      selectFromEvent(event);
    }
  });

  // First paint: the full board, with the rank-1 protocol already in the detail
  // view (no scrolling on load — the reader starts at the masthead).
  renderBoard();
  if (topRow) select(topRow.slug, false);
})();