/* Dragging issues between statuses.
 *
 * Optimistic like the retro board, and guarded the same way: the move carries
 * the version the browser had, and a rejection hands back the authoritative
 * issue so the card can snap to where it really is. */

const board = document.getElementById('issue-board');
const toasts = document.getElementById('toasts');
if (board) {
  const projectKey = board.dataset.project;
  let dragging = null;
  let dropLine = null;

  function toast(message, variant) {
    const el = document.createElement('div');
    el.className = `toast${variant ? ` toast-${variant}` : ''}`;
    el.textContent = message;
    toasts.append(el);
    setTimeout(() => el.remove(), 3200);
  }

  function clearDropLine() {
    dropLine?.remove();
    dropLine = null;
    for (const column of board.querySelectorAll('.column')) column.classList.remove('drag-over');
  }

  function insertionIndex(list, clientY) {
    const cards = [...list.querySelectorAll('.icard:not(.dragging)')];
    for (const [index, card] of cards.entries()) {
      const box = card.getBoundingClientRect();
      if (clientY < box.top + box.height / 2) return index;
    }
    return cards.length;
  }

  function updateCounts() {
    for (const column of board.querySelectorAll('.column')) {
      const count = column.querySelectorAll('.icard').length;
      column.querySelector('.column-count').textContent = String(count);
      const placeholder = column.querySelector('.column-list > p');
      if (placeholder) placeholder.hidden = count > 0;
    }
  }

  board.addEventListener('dragstart', (event) => {
    const card = event.target.closest('.icard');
    if (!card) return;
    dragging = card;
    card.classList.add('dragging');
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', card.dataset.issue);
  });

  board.addEventListener('dragend', () => {
    dragging?.classList.remove('dragging');
    dragging = null;
    clearDropLine();
  });

  for (const list of board.querySelectorAll('.column-list')) {
    list.addEventListener('dragover', (event) => {
      if (!dragging) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      list.closest('.column').classList.add('drag-over');
      const cards = [...list.querySelectorAll('.icard:not(.dragging)')];
      const index = insertionIndex(list, event.clientY);
      dropLine ??= Object.assign(document.createElement('div'), { className: 'drop-line' });
      if (index >= cards.length) list.append(dropLine);
      else cards[index].before(dropLine);
    });

    list.addEventListener('dragleave', (event) => {
      if (!list.contains(event.relatedTarget)) list.closest('.column').classList.remove('drag-over');
    });

    list.addEventListener('drop', async (event) => {
      event.preventDefault();
      if (!dragging) return;
      const card = dragging;
      const status = list.dataset.status;
      const cards = [...list.querySelectorAll('.icard:not(.dragging)')];
      const index = insertionIndex(list, event.clientY);
      const beforeId = index > 0 ? cards[index - 1].dataset.issue : null;

      // Remember where it came from, in case the server says no.
      const origin = { parent: card.parentElement, next: card.nextElementSibling };
      if (index >= cards.length) list.append(card);
      else cards[index].before(card);
      clearDropLine();
      updateCounts();

      const response = await fetch(`/api/projects/${projectKey}/issues/${card.dataset.issue}/move`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status, beforeId, baseVersion: Number(card.dataset.version) }),
      })
        .then((r) => r.json())
        .catch(() => ({ ok: false, message: 'Could not reach the server.' }));

      if (response.ok) {
        card.dataset.version = String(response.issue.version);
        return;
      }
      // Put it back exactly where it was, then say why.
      origin.parent.insertBefore(card, origin.next);
      updateCounts();
      card.classList.add('conflict');
      setTimeout(() => card.classList.remove('conflict'), 400);
      if (response.issue) card.dataset.version = String(response.issue.version);
      toast(response.message ?? 'Could not move that issue.', 'warn');
    });
  }
}
