/* Pulseboard client.
 *
 * Every mutation is applied locally first and confirmed by the server's ack.
 * The server is the only authority on ordering: an ack carries the card's real
 * sort key and version, and a rejected op replaces the local card with the
 * authoritative one, which is what makes a losing drag snap back.
 */

const bootstrap = JSON.parse(document.getElementById('bootstrap').textContent);
const socket = io({ auth: bootstrap.identity, transports: ['websocket', 'polling'] });

const boardEl = document.getElementById('board');
const cursorLayer = document.getElementById('cursors');
const presenceEl = document.getElementById('presence');
const connEl = document.getElementById('conn');
const toastsEl = document.getElementById('toasts');
const revealBtn = document.getElementById('reveal-toggle');

const state = {
  board: null,
  columns: [],
  cards: [],
  members: [],
  you: bootstrap.identity,
};

let editingCardId = null;
let pendingMoves = 0;
const columnEls = new Map();
const cursors = new Map();
const seenCards = new Set();

/* ---------------------------------------------------------------- helpers */

function bySortKey(a, b) {
  if (a.sortKey === b.sortKey) return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  return a.sortKey < b.sortKey ? -1 : 1;
}

function sortCards() {
  // Holding off while a drag is in flight keeps the dragged card under the
  // cursor instead of snapping back to its old key for one round trip.
  if (pendingMoves === 0) state.cards.sort(bySortKey);
}

function cardsIn(columnId) {
  return state.cards.filter((card) => card.columnId === columnId);
}

function upsertCard(card) {
  const index = state.cards.findIndex((c) => c.id === card.id);
  if (index === -1) state.cards.push(card);
  else state.cards[index] = { ...state.cards[index], ...card };
  sortCards();
}

function toast(message, variant) {
  const el = document.createElement('div');
  el.className = `toast${variant ? ` toast-${variant}` : ''}`;
  el.textContent = message;
  toastsEl.append(el);
  setTimeout(() => el.remove(), 3200);
}

function initials(name) {
  return name.split(/\s+/).slice(0, 2).map((part) => part[0] ?? '').join('').toUpperCase();
}

function emit(event, payload) {
  return new Promise((resolve) => socket.emit(event, payload, resolve));
}

/* ----------------------------------------------------------------- render */

function render() {
  document.getElementById('loading')?.remove();

  for (const [id, el] of columnEls) {
    if (!state.columns.some((column) => column.id === id)) {
      el.root.remove();
      columnEls.delete(id);
    }
  }

  for (const column of state.columns) {
    let refs = columnEls.get(column.id);
    if (!refs) {
      refs = buildColumn(column);
      columnEls.set(column.id, refs);
      boardEl.append(refs.root);
    }
    refs.title.textContent = column.title;
    renderCards(column, refs);
  }
  renderPresence();
  renderRevealButton();
  applyBoardTitle();
}

function buildColumn(column) {
  const root = document.createElement('section');
  root.className = 'column';
  root.dataset.columnId = column.id;

  const head = document.createElement('header');
  head.className = 'column-head';
  const title = document.createElement('span');
  title.className = 'column-title';
  title.title = 'Rename this column';
  const count = document.createElement('span');
  count.className = 'column-count';

  const actions = document.createElement('span');
  actions.className = 'column-actions';
  const rename = document.createElement('button');
  rename.className = 'pcard-btn';
  rename.type = 'button';
  rename.textContent = '✎';
  rename.title = 'Rename column';
  rename.setAttribute('aria-label', `Rename the ${column.title} column`);
  const removeColumn = document.createElement('button');
  removeColumn.className = 'pcard-btn pcard-del';
  removeColumn.type = 'button';
  removeColumn.textContent = '×';
  removeColumn.title = 'Delete column';
  removeColumn.setAttribute('aria-label', `Delete the ${column.title} column`);

  const doRename = async () => {
    const next = window.prompt('Column name', column.title);
    if (next === null || !next.trim() || next.trim() === column.title) return;
    const response = await emit('column:rename', { columnId: column.id, title: next.trim() });
    if (response?.ok) {
      const index = state.columns.findIndex((c) => c.id === column.id);
      if (index !== -1) state.columns[index] = response.column;
      render();
    } else {
      toast(response?.message ?? 'Could not rename that column.', 'warn');
    }
  };
  rename.addEventListener('click', doRename);
  title.addEventListener('dblclick', doRename);

  removeColumn.addEventListener('click', async () => {
    const cardCount = cardsIn(column.id).length;
    const warning = cardCount
      ? `Delete “${column.title}” and its ${cardCount} card${cardCount === 1 ? '' : 's'}?`
      : `Delete “${column.title}”?`;
    if (!window.confirm(warning)) return;
    const response = await emit('column:delete', { columnId: column.id });
    if (response?.ok) {
      state.columns = state.columns.filter((c) => c.id !== column.id);
      state.cards = state.cards.filter((c) => c.columnId !== column.id);
      render();
    } else {
      toast(response?.message ?? 'Could not delete that column.', 'warn');
    }
  });

  actions.append(rename, removeColumn);
  head.append(title, count, actions);

  const list = document.createElement('div');
  list.className = 'column-list';

  const composer = document.createElement('div');
  composer.className = 'composer';
  composer.style.padding = '0 10px 12px';
  const textarea = document.createElement('textarea');
  textarea.rows = 1;
  textarea.placeholder = 'Add a card…  (Enter to save)';
  textarea.setAttribute('aria-label', `Add a card to ${column.title}`);
  composer.append(textarea);

  textarea.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      const body = textarea.value.trim();
      if (!body) return;
      textarea.value = '';
      addCard(column.id, body);
    }
  });

  list.addEventListener('dragover', (event) => onDragOver(event, column, list));
  list.addEventListener('dragleave', () => root.classList.remove('drag-over'));
  list.addEventListener('drop', (event) => onDrop(event, column, list));

  root.append(head, list, composer);
  return { root, title, count, list };
}

function renderCards(column, refs) {
  const cards = cardsIn(column.id);
  refs.count.textContent = cards.length ? String(cards.length) : '';

  if (cards.length === 0) {
    refs.list.replaceChildren(emptyColumn(column));
    return;
  }

  const nodes = cards.map((card) =>
    card.id === editingCardId ? refs.list.querySelector(`[data-card-id="${card.id}"]`) ?? cardNode(card) : cardNode(card),
  );
  refs.list.replaceChildren(...nodes);
}

function emptyColumn(column) {
  const el = document.createElement('p');
  el.className = 'faint small';
  el.style.padding = '6px 4px 10px';
  el.textContent =
    state.board.kind === 'retro'
      ? `Nothing under “${column.title}” yet.`
      : `No cards in ${column.title}.`;
  return el;
}

function cardNode(card) {
  const el = document.createElement('article');
  el.className = 'pcard';
  // Animate a card in only the first time this client sees it.
  if (!seenCards.has(card.id)) {
    el.classList.add('is-new');
    seenCards.add(card.id);
  }
  el.dataset.cardId = card.id;
  el.draggable = true;
  if (card.pending) el.classList.add('pending');

  const body = document.createElement('div');
  body.className = card.masked ? 'pcard-body pcard-masked' : 'pcard-body';
  body.textContent = card.masked ? '•••••• hidden until reveal' : card.body;
  if (!card.masked) {
    body.title = 'Click to edit';
    body.addEventListener('click', () => {
      if (editingCardId !== card.id) beginEdit(card, body, el);
    });
  }

  const foot = document.createElement('div');
  foot.className = 'pcard-foot';

  const vote = document.createElement('button');
  vote.className = 'vote';
  vote.type = 'button';
  vote.dataset.voted = String(card.votedByMe);
  vote.textContent = `▲ ${card.votes}`;
  vote.setAttribute('aria-label', `${card.votes} votes. Click to ${card.votedByMe ? 'remove your vote' : 'vote'}`);
  vote.addEventListener('click', () => voteCard(card));

  const author = document.createElement('span');
  author.textContent = card.authorName;

  const actions = document.createElement('span');
  actions.className = 'pcard-actions';

  if (!card.masked) {
    const edit = document.createElement('button');
    edit.className = 'pcard-btn';
    edit.type = 'button';
    edit.textContent = '✎';
    edit.title = 'Edit card (or double-click the text)';
    edit.setAttribute('aria-label', 'Edit card');
    edit.addEventListener('click', () => beginEdit(card, body, el));
    actions.append(edit);
  }

  const del = document.createElement('button');
  del.className = 'pcard-btn pcard-del';
  del.type = 'button';
  del.textContent = '×';
  del.title = 'Delete card';
  del.setAttribute('aria-label', 'Delete card');
  del.addEventListener('click', () => removeCard(card));
  actions.append(del);

  foot.append(vote, author, actions);
  el.append(body, foot);

  el.addEventListener('dragstart', (event) => {
    event.dataTransfer.setData('text/plain', card.id);
    event.dataTransfer.effectAllowed = 'move';
    el.classList.add('dragging');
  });
  el.addEventListener('dragend', () => {
    el.classList.remove('dragging');
    clearDropLine();
  });

  return el;
}

function renderPresence() {
  presenceEl.replaceChildren(
    ...state.members.slice(0, 6).map((member) => {
      const el = document.createElement('div');
      const isMe = member.id === state.you.id;
      el.className = isMe ? 'avatar avatar-me' : 'avatar';
      el.style.background = member.color;
      el.textContent = initials(member.name);
      el.title = isMe ? `${member.name} (you) — click to rename` : member.name;
      return el;
    }),
  );
  if (state.members.length > 6) {
    const more = document.createElement('div');
    more.className = 'avatar';
    more.style.background = '#8d93a1';
    more.textContent = `+${state.members.length - 6}`;
    presenceEl.append(more);
  }
}

function applyBoardTitle() {
  const heading = document.getElementById('board-title');
  if (heading) heading.textContent = state.board.title;
  document.title = `${state.board.title} — Pulseboard`;
}

function renderRevealButton() {
  if (!revealBtn || state.board.kind !== 'retro') return;
  revealBtn.hidden = false;
  revealBtn.textContent = state.board.cardsHidden ? 'Reveal cards' : 'Hide cards';
  revealBtn.className = state.board.cardsHidden ? 'btn btn-sm btn-primary' : 'btn btn-sm';
}

/* ------------------------------------------------------------- mutations */

async function addCard(columnId, body) {
  const optimisticId = `pending-${Math.random().toString(36).slice(2)}`;
  const head = cardsIn(columnId)[0];
  const optimistic = {
    id: optimisticId,
    columnId,
    body,
    // Sorts before the current head without minting a real key; the ack
    // replaces it with the server's.
    sortKey: head ? head.sortKey.slice(0, -1) + '!' : '!',
    version: 1,
    authorId: state.you.id,
    authorName: state.you.name,
    votes: 0,
    votedByMe: false,
    masked: false,
    pending: true,
  };
  state.cards.unshift(optimistic);
  render();

  const response = await emit('card:create', { columnId, body });
  state.cards = state.cards.filter((card) => card.id !== optimisticId);
  if (response?.ok) upsertCard(response.card);
  else toast(response?.message ?? 'Could not add that card.', 'warn');
  render();
}

function beginEdit(card, bodyEl, cardEl) {
  editingCardId = card.id;
  cardEl.draggable = false;
  bodyEl.contentEditable = 'true';
  bodyEl.focus();
  const range = document.createRange();
  range.selectNodeContents(bodyEl);
  window.getSelection().removeAllRanges();
  window.getSelection().addRange(range);

  const finish = async (commit) => {
    bodyEl.contentEditable = 'false';
    cardEl.draggable = true;
    editingCardId = null;
    const next = bodyEl.textContent.trim();
    if (!commit || !next || next === card.body) {
      render();
      return;
    }
    const response = await emit('card:edit', { cardId: card.id, body: next, baseVersion: card.version });
    if (response?.ok) {
      upsertCard(response.card);
    } else if (response?.code === 'CONFLICT' && response.card) {
      upsertCard(response.card);
      flashConflict(response.card.id);
      toast(response.message, 'warn');
    } else {
      toast(response?.message ?? 'Could not save that edit.', 'warn');
    }
    render();
  };

  bodyEl.addEventListener('blur', () => finish(true), { once: true });
  bodyEl.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      bodyEl.blur();
    }
    if (event.key === 'Escape') {
      bodyEl.textContent = card.body;
      bodyEl.blur();
    }
  });
}

async function voteCard(card) {
  // Optimistic and unguarded: votes commute, so there is nothing to conflict on.
  card.votedByMe = !card.votedByMe;
  card.votes += card.votedByMe ? 1 : -1;
  render();
  const response = await emit('card:vote', { cardId: card.id });
  if (response?.ok) upsertCard(response.card);
  else toast(response?.message ?? 'Vote did not stick.', 'warn');
  render();
}

async function removeCard(card) {
  const snapshot = [...state.cards];
  state.cards = state.cards.filter((c) => c.id !== card.id);
  render();
  const response = await emit('card:delete', { cardId: card.id });
  if (!response?.ok && response?.code !== 'NOT_FOUND') {
    state.cards = snapshot;
    toast(response?.message ?? 'Could not delete that card.', 'warn');
    render();
  }
}

async function moveCard(cardId, columnId, index) {
  const card = state.cards.find((c) => c.id === cardId);
  if (!card || card.pending) return;

  const target = cardsIn(columnId).filter((c) => c.id !== cardId);
  const beforeId = index > 0 ? target[index - 1]?.id ?? null : null;
  const afterId = target[index]?.id ?? null;
  const snapshot = { columnId: card.columnId, sortKey: card.sortKey, version: card.version };
  const baseVersion = card.version;

  // Optimistic: pull the card out and splice it into the requested slot. The
  // array order is what render() uses, so this is what the dragger sees.
  state.cards = state.cards.filter((c) => c.id !== cardId);
  const targetCards = state.cards.filter((c) => c.columnId === columnId);
  const anchor = targetCards[index];
  const insertAt = anchor ? state.cards.indexOf(anchor) : state.cards.length;
  card.columnId = columnId;
  state.cards.splice(insertAt, 0, card);
  pendingMoves += 1;
  render();

  const response = await emit('card:move', { cardId, columnId, beforeId, afterId, baseVersion });
  pendingMoves -= 1;

  if (response?.ok) {
    upsertCard(response.card);
  } else if (response?.code === 'CONFLICT' && response.card) {
    Object.assign(card, snapshot);
    upsertCard(response.card);
    flashConflict(response.card.id);
    toast(response.message, 'warn');
  } else if (response?.code === 'NOT_FOUND') {
    state.cards = state.cards.filter((c) => c.id !== cardId);
    toast(response.message, 'warn');
  } else {
    Object.assign(card, snapshot);
    toast(response?.message ?? 'Could not move that card.', 'warn');
  }
  sortCards();
  render();
}

function flashConflict(cardId) {
  requestAnimationFrame(() => {
    const el = boardEl.querySelector(`[data-card-id="${cardId}"]`);
    if (!el) return;
    el.classList.add('conflict');
    setTimeout(() => el.classList.remove('conflict'), 400);
  });
}

/* ------------------------------------------------------------ drag & drop */

let dropLine = null;

function clearDropLine() {
  dropLine?.remove();
  dropLine = null;
  for (const refs of columnEls.values()) refs.root.classList.remove('drag-over');
}

function insertionIndex(list, clientY) {
  const nodes = [...list.querySelectorAll('.pcard:not(.dragging)')];
  for (const [index, node] of nodes.entries()) {
    const box = node.getBoundingClientRect();
    if (clientY < box.top + box.height / 2) return index;
  }
  return nodes.length;
}

function onDragOver(event, column, list) {
  event.preventDefault();
  event.dataTransfer.dropEffect = 'move';
  columnEls.get(column.id)?.root.classList.add('drag-over');

  const index = insertionIndex(list, event.clientY);
  const nodes = [...list.querySelectorAll('.pcard:not(.dragging)')];
  dropLine ??= Object.assign(document.createElement('div'), { className: 'drop-line' });
  if (index >= nodes.length) list.append(dropLine);
  else nodes[index].before(dropLine);
}

function onDrop(event, column, list) {
  event.preventDefault();
  const cardId = event.dataTransfer.getData('text/plain');
  const index = insertionIndex(list, event.clientY);
  clearDropLine();
  if (cardId) moveCard(cardId, column.id, index);
}

/* -------------------------------------------------------------- presence */

let lastCursorSent = 0;
boardEl.addEventListener('mousemove', (event) => {
  const now = Date.now();
  if (now - lastCursorSent < 40) return;
  lastCursorSent = now;
  const box = boardEl.getBoundingClientRect();
  socket.emit('cursor', {
    x: (event.clientX - box.left) / box.width,
    y: (event.clientY - box.top + boardEl.scrollTop) / box.height,
  });
});

function renderCursor({ id, name, color, x, y }) {
  let el = cursors.get(id);
  if (!el) {
    el = document.createElement('div');
    el.className = 'cursor';
    el.innerHTML =
      '<svg width="14" height="18" viewBox="0 0 14 18"><path d="M1 1l11 7-5 1.3L4.6 16z" fill="currentColor" stroke="white" stroke-width="1.2"/></svg><span></span>';
    cursorLayer.append(el);
    cursors.set(id, el);
  }
  el.style.color = color;
  el.style.setProperty('--cursor-color', color);
  el.querySelector('span').textContent = name;
  const box = boardEl.getBoundingClientRect();
  el.style.left = `${x * box.width}px`;
  el.style.top = `${y * box.height}px`;
  clearTimeout(el.dataset.timer);
  el.dataset.timer = setTimeout(() => {
    el.remove();
    cursors.delete(id);
  }, 8000);
}

/* --------------------------------------------------------------- sockets */

async function join() {
  connEl.dataset.state = 'connecting';
  connEl.textContent = 'Connecting…';
  const response = await emit('join', { slug: bootstrap.slug });
  if (!response?.ok) {
    connEl.dataset.state = 'offline';
    connEl.textContent = response?.message ?? 'Could not join';
    return;
  }
  state.board = response.board;
  state.columns = response.columns;
  state.cards = response.cards;
  state.members = response.members;
  state.you = response.you;
  pendingMoves = 0;
  sortCards();
  connEl.dataset.state = 'online';
  connEl.textContent = `Live · ${state.members.length} here`;
  render();
}

socket.on('connect', join);
socket.io.on('reconnect', join);

socket.on('disconnect', () => {
  connEl.dataset.state = 'offline';
  connEl.textContent = 'Reconnecting…';
});

socket.on('presence', ({ members }) => {
  state.members = members;
  if (connEl.dataset.state === 'online') connEl.textContent = `Live · ${members.length} here`;
  renderPresence();
});

socket.on('card:created', ({ card }) => {
  upsertCard(card);
  render();
});

socket.on('card:updated', ({ card }) => {
  if (card.id === editingCardId) return; // never yank text out from under a typist
  upsertCard(card);
  render();
});

socket.on('card:votes', ({ cardId, votes }) => {
  const card = state.cards.find((c) => c.id === cardId);
  if (!card) return;
  card.votes = votes; // votedByMe is this viewer's business, so it is left alone
  render();
});

socket.on('card:deleted', ({ cardId }) => {
  state.cards = state.cards.filter((card) => card.id !== cardId);
  render();
});

socket.on('column:updated', ({ column }) => {
  const index = state.columns.findIndex((c) => c.id === column.id);
  if (index !== -1) state.columns[index] = column;
  render();
});

socket.on('column:deleted', ({ columnId }) => {
  state.columns = state.columns.filter((c) => c.id !== columnId);
  state.cards = state.cards.filter((c) => c.columnId !== columnId);
  render();
});

socket.on('column:created', ({ column }) => {
  state.columns = [...state.columns, column];
  render();
});

socket.on('board:updated', ({ board, resync }) => {
  state.board = board;
  // Masking happens on the server, so a reveal means refetching the bodies.
  if (resync) join();
  else render();
});

socket.on('cursor', renderCursor);
socket.on('cursor:gone', ({ id }) => {
  cursors.get(id)?.remove();
  cursors.delete(id);
});

/* ----------------------------------------------------------------- chrome */

revealBtn?.addEventListener('click', async () => {
  const response = await emit('board:hidden', { hidden: !state.board.cardsHidden });
  if (response?.ok) {
    state.board = response.board;
    await join();
  }
});

document.getElementById('board-title')?.addEventListener('click', async () => {
  const next = window.prompt('Board name', state.board.title);
  if (next === null || !next.trim() || next.trim() === state.board.title) return;
  const response = await emit('board:rename', { title: next.trim() });
  if (response?.ok) {
    state.board = response.board;
    applyBoardTitle();
  } else {
    toast(response?.message ?? 'Could not rename the board.', 'warn');
  }
});

/** Your display name is yours; nobody wants to be Eager Otter forever. */
document.getElementById('presence').addEventListener('click', (event) => {
  if (!event.target.closest('.avatar-me')) return;
  const next = window.prompt('Your name on this board', state.you.name);
  if (next === null || !next.trim() || next.trim() === state.you.name) return;
  const name = next.trim().slice(0, 32);
  document.cookie = `pb_name=${encodeURIComponent(name)};path=/;max-age=31536000;samesite=lax`;
  socket.auth = { ...socket.auth, name };
  // The server reads identity from the handshake, so it needs a fresh one.
  socket.disconnect().connect();
  toast(`You are ${name} now.`);
});

document.getElementById('add-column').addEventListener('click', async () => {
  const title = window.prompt('Column name');
  if (!title?.trim()) return;
  const response = await emit('column:add', { title: title.trim() });
  if (response?.ok) {
    state.columns = [...state.columns, response.column];
    render();
  } else {
    toast(response?.message ?? 'Could not add that column.', 'warn');
  }
});

document.getElementById('copy-link').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(window.location.href);
    toast('Board link copied. Open it in another window.');
  } catch {
    toast(window.location.href);
  }
});
